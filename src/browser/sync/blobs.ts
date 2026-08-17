// Content-addressed blob substitution and transfer. `toBlobRefs` pulls
// large inline data URLs (avatars) out of a document into a `$blob`
// reference before it's hashed/pushed; `fromBlobRefs` is the inverse on
// pull. Keeping this entirely outside `namespaces.ts` is deliberate — no
// namespace registration needs to know blobs exist.
import { get as dbGet, putSilent } from '../db/index'
import { resolveConnection, buildHeaders, httpFetch } from '../llm/ollama'
import { blobCheckResponseSchema } from './wire'
import { sha256HexBytes } from './hash'

/** Below this, a round trip through the blob store costs more than just
 * inlining the bytes — matches Amallo's blob-vs-inline tradeoff point. */
const BLOB_MIN_BYTES = 4096
const BLOB_TIMEOUT_MS = 120_000
const CHECK_TIMEOUT_MS = 15_000

interface BlobRef {
  $blob: string
  mime: string
  size: number
}

const isBlobRef = (value: unknown): value is BlobRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { $blob?: unknown }).$blob === 'string'

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  // Chunked to avoid a stack-overflow-prone single String.fromCharCode(...bytes)
  // spread on large avatars.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/**
 * Walks `doc`, replacing any base64 data URL of at least `BLOB_MIN_BYTES`
 * with `{ $blob, mime, size }`. Bytes for every replaced ref are stashed in
 * `pending` (hash -> bytes), for the caller to check/upload once per pass
 * before pushing the record that now only carries the reference.
 */
export const toBlobRefs = async (
  doc: unknown,
  pending: Map<string, Uint8Array>
): Promise<unknown> => {
  if (typeof doc === 'string') {
    const match = DATA_URL.exec(doc)
    if (!match) return doc
    const [, mime, b64] = match
    const bytes = base64ToBytes(b64)
    if (bytes.length < BLOB_MIN_BYTES) return doc
    const hash = await sha256HexBytes(bytes)
    pending.set(hash, bytes)
    return { $blob: hash, mime, size: bytes.length } satisfies BlobRef
  }
  if (Array.isArray(doc)) {
    return Promise.all(doc.map((v) => toBlobRefs(v, pending)))
  }
  if (doc && typeof doc === 'object') {
    const entries = await Promise.all(
      Object.entries(doc).map(async ([k, v]) => [k, await toBlobRefs(v, pending)] as const)
    )
    return Object.fromEntries(entries)
  }
  return doc
}

interface CachedBlob {
  hash: string
  mime: string
  bytes: ArrayBuffer
}

const resolveBlob = async (hash: string, mime: string): Promise<string | undefined> => {
  const cached = await dbGet<CachedBlob>('blobCache', hash)
  if (cached) return `data:${cached.mime};base64,${bytesToBase64(new Uint8Array(cached.bytes))}`

  const connection = await resolveConnection()
  let res: Response
  try {
    res = await httpFetch(connection)(`${connection.baseUrl}/extended/v1/blob/${hash}`, {
      headers: buildHeaders(connection),
      signal: AbortSignal.timeout(BLOB_TIMEOUT_MS)
    })
  } catch {
    return undefined // non-fatal: drop the field, per the client rule below
  }
  // A 404 is expected and non-fatal (the referencing document may have
  // been tombstoned server-side between when this device pulled it and
  // when it fetches the blob) — never fail the record, never fail the pass.
  if (!res.ok) return undefined

  const buf = await res.arrayBuffer()
  await putSilent('blobCache', { hash, mime, bytes: buf })
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(buf))}`
}

/** Inverse of `toBlobRefs`. A `$blob` ref that can't be resolved (offline,
 * 404) is dropped from the document rather than failing the whole record —
 * e.g. a character applies with no avatar rather than not applying at all. */
export const fromBlobRefs = async (doc: unknown): Promise<unknown> => {
  if (isBlobRef(doc)) {
    return resolveBlob(doc.$blob, doc.mime)
  }
  if (Array.isArray(doc)) {
    const mapped = await Promise.all(doc.map((v) => fromBlobRefs(v)))
    return mapped.filter((v) => v !== undefined)
  }
  if (doc && typeof doc === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(doc)) {
      const hydrated = await fromBlobRefs(v)
      if (hydrated !== undefined) out[k] = hydrated
    }
    return out
  }
  return doc
}

const checkMissingBlobs = async (hashes: string[]): Promise<string[]> => {
  if (hashes.length === 0) return []
  const connection = await resolveConnection()
  const res = await httpFetch(connection)(`${connection.baseUrl}/extended/v1/blobs/check`, {
    method: 'POST',
    headers: buildHeaders(connection, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ hashes }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`blobs/check failed (${res.status})`)
  return blobCheckResponseSchema.parse(await res.json()).missing
}

const uploadBlob = async (hash: string, bytes: Uint8Array): Promise<void> => {
  const connection = await resolveConnection()
  const res = await httpFetch(connection)(`${connection.baseUrl}/extended/v1/blob/${hash}`, {
    method: 'PUT',
    headers: buildHeaders(connection, { 'Content-Type': 'application/octet-stream' }),
    // `.slice().buffer` rather than `bytes` itself: TS 5.7's generic
    // TypedArray types (`Uint8Array<ArrayBufferLike>`) don't structurally
    // satisfy `BodyInit` in every lib.dom.d.ts version, but a concrete
    // `ArrayBuffer` unambiguously does — `slice()` also guarantees a
    // tightly-sized buffer rather than whatever `bytes` happens to be a
    // view over.
    body: bytes.slice().buffer as ArrayBuffer,
    signal: AbortSignal.timeout(BLOB_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`blob upload failed (${res.status})`)
}

/** Checks which of `pending`'s blobs the server is missing, then uploads
 * exactly those. Must run to completion BEFORE pushing any record that
 * references one of these hashes — a push referencing an absent blob comes
 * back `missingBlobs` and writes nothing. */
export const uploadPendingBlobs = async (pending: Map<string, Uint8Array>): Promise<void> => {
  if (pending.size === 0) return
  const hashes = [...pending.keys()]
  const missing = await checkMissingBlobs(hashes)
  for (const hash of missing) {
    const bytes = pending.get(hash)
    if (bytes) await uploadBlob(hash, bytes)
  }
}
