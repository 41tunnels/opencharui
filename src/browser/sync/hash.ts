/**
 * SHA-256 over raw bytes, not a canonical structural form — the hash is
 * computed over `JSON.stringify(data)` exactly as sent, and Amallo hashes
 * the exact bytes it receives. Neither side canonicalizes; convergence
 * comes from both devices running the same TypeScript serialization path,
 * not from a spec. See `registry.ts`'s `SyncNamespace.list()` contract for
 * the two rules that make that hold (schema-parsed, derived fields
 * stripped).
 */
export const sha256Hex = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const sha256HexBytes = async (bytes: Uint8Array): Promise<string> => {
  // crypto.subtle.digest wants an ArrayBuffer-backed view; slice() copies
  // into a plain buffer so a Uint8Array over a larger/offset buffer (e.g. a
  // fetch response chunk) can't leak neighboring bytes into the digest.
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of the empty byte string — the fixed hash convention for
 * tombstones (which carry no `data`), matching Amallo's
 * `store::hash::EMPTY_HASH`. This is what makes repeated local deletes of
 * the same key idempotent on push (`duplicate`, not a fresh `applied`). */
export const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
