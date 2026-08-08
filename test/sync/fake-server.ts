// A tiny in-memory reimplementation of just enough of /extended/v1 to drive
// the client engine end-to-end in tests, mirroring
// amallo/src-tauri/src/store/records.rs's push/pull/wins() semantics
// closely enough to exercise the client against realistic responses.
import { vi } from 'vitest'
import { EMPTY_HASH, sha256Hex, sha256HexBytes } from '@browser/sync/hash'

interface FakeRecord {
  namespace: string
  key: string
  seq: number
  hash: string
  updatedAt: number
  deleted: boolean
  data?: unknown
}

interface PushRecordIn {
  namespace: string
  key: string
  hash: string
  updatedAt: number
  deleted?: boolean
  data?: unknown
}

const collectBlobRefs = (value: unknown, out: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const v of value) collectBlobRefs(v, out)
    return
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$blob === 'string') out.add(obj.$blob)
    for (const v of Object.values(obj)) collectBlobRefs(v, out)
  }
}

export const createFakeServer = (storeId: string = crypto.randomUUID()) => {
  let seq = 0
  const records = new Map<string, FakeRecord>()
  const blobs = new Map<string, Uint8Array>()

  const wins = (incomingHash: string, incomingUpdatedAt: number, incomingDeleted: boolean, existing: FakeRecord): boolean => {
    if (incomingHash === existing.hash) return false
    if (incomingUpdatedAt !== existing.updatedAt) return incomingUpdatedAt > existing.updatedAt
    if (incomingDeleted !== existing.deleted) return incomingDeleted
    return incomingHash > existing.hash
  }

  const handlePush = async (body: { records: PushRecordIn[] }) => {
    const results = []
    for (const rec of body.records) {
      const deleted = rec.deleted ?? false
      const expected = deleted ? EMPTY_HASH : await sha256Hex(JSON.stringify(rec.data))
      if (expected !== rec.hash) {
        results.push({ namespace: rec.namespace, key: rec.key, status: 'rejected', seq: 0, hash: '', message: 'hash mismatch' })
        continue
      }

      if (!deleted) {
        const refs = new Set<string>()
        collectBlobRefs(rec.data, refs)
        const missing = [...refs].filter((h) => !blobs.has(h))
        if (missing.length > 0) {
          results.push({ namespace: rec.namespace, key: rec.key, status: 'missingBlobs', seq: 0, hash: '', missingBlobs: missing })
          continue
        }
      }

      const id = `${rec.namespace}:${rec.key}`
      const existing = records.get(id)
      if (existing && existing.hash === expected) {
        results.push({ namespace: rec.namespace, key: rec.key, status: 'duplicate', seq: existing.seq, hash: existing.hash })
        continue
      }
      if (existing && !wins(expected, rec.updatedAt, deleted, existing)) {
        results.push({ namespace: rec.namespace, key: rec.key, status: 'superseded', seq: existing.seq, hash: existing.hash })
        continue
      }

      seq += 1
      records.set(id, { namespace: rec.namespace, key: rec.key, seq, hash: expected, updatedAt: rec.updatedAt, deleted, data: rec.data })
      results.push({ namespace: rec.namespace, key: rec.key, status: 'applied', seq, hash: expected })
    }
    return { storeId, head: seq, results }
  }

  const handlePull = (body: { since?: number; limit?: number; namespaces?: string[] }) => {
    const since = body.since ?? 0
    const limit = body.limit ?? 256
    let all = [...records.values()].filter((r) => r.seq > since)
    if (body.namespaces) all = all.filter((r) => body.namespaces!.includes(r.namespace))
    all.sort((a, b) => a.seq - b.seq)
    const page = all.slice(0, limit)
    const more = all.length > limit
    return {
      storeId,
      head: seq,
      reapFloor: 0,
      cursor: page.length > 0 ? page[page.length - 1].seq : seq,
      more,
      records: page.map((r) => ({
        namespace: r.namespace,
        key: r.key,
        seq: r.seq,
        hash: r.hash,
        updatedAt: r.updatedAt,
        deleted: r.deleted,
        ...(r.deleted ? {} : { data: r.data })
      }))
    }
  }

  const handleInfo = () => ({ protocol: 1, storeId, head: seq, reapFloor: 0, serverTime: Date.now() })

  const handleBlobPut = async (hash: string, bytes: Uint8Array): Promise<{ status: number; body?: unknown }> => {
    const actual = await sha256HexBytes(bytes)
    if (actual !== hash) return { status: 400, body: { error: 'hashMismatch', message: 'mismatch' } }
    blobs.set(hash, bytes)
    return { status: 200, body: { hash, size: bytes.length, created: true } }
  }

  const handleBlobCheck = (hashes: string[]) => ({ missing: hashes.filter((h) => !blobs.has(h)) })
  const handleBlobGet = (hash: string): Uint8Array | undefined => blobs.get(hash)

  return { storeId, records, blobs, handlePush, handlePull, handleInfo, handleBlobPut, handleBlobCheck, handleBlobGet }
}

export type FakeServer = ReturnType<typeof createFakeServer>

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Installs `global.fetch` as a router into `server`. Every call carries an
 * `AbortSignal` per the engine's timeout contract — tests can assert on
 * `init?.signal instanceof AbortSignal` if needed. */
export const installFetchMock = (
  server: FakeServer,
  base = 'http://amallo.test'
): { calls: Array<{ path: string; init?: RequestInit }> } => {
  const calls: Array<{ path: string; init?: RequestInit }> = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), base)
      const path = url.pathname
      calls.push({ path, init })

      if (path === '/extended/v1/info') return jsonResponse(server.handleInfo())
      if (path === '/extended/v1/pull') {
        return jsonResponse(server.handlePull(JSON.parse(String(init?.body ?? '{}'))))
      }
      if (path === '/extended/v1/push') {
        return jsonResponse(await server.handlePush(JSON.parse(String(init?.body ?? '{}'))))
      }
      if (path === '/extended/v1/blobs/check') {
        return jsonResponse(server.handleBlobCheck(JSON.parse(String(init?.body ?? '{}')).hashes))
      }
      if (path.startsWith('/extended/v1/blob/')) {
        const hash = path.split('/').pop() ?? ''
        if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
          const bytes = new Uint8Array(init!.body as ArrayBuffer)
          const result = await server.handleBlobPut(hash, bytes)
          return jsonResponse(result.body ?? {}, result.status)
        }
        const bytes = server.handleBlobGet(hash)
        if (!bytes) return new Response('not found', { status: 404 })
        return new Response(bytes.slice().buffer, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
  )

  return { calls }
}
