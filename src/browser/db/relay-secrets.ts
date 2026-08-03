import { deleteByKeySilent, get, putSilent } from './index'
import { importPsk } from '../relay/crypto'

interface SecretRow {
  key: string
  value: CryptoKey
}

/** Generates a fresh, random storage id — not a security value itself
 * (see `AppSettings.relayPskId`'s doc comment), just an indirection layer
 * so the `relaySecrets` store isn't hardcoded to one fixed row. */
const generateId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Imports raw PSK bytes (via `crypto.ts`'s `importPsk`) as a
 * non-extractable HKDF key and persists it — via IndexedDB's
 * structured-clone algorithm, which has native support for `CryptoKey`
 * and preserves its non-extractable flag — under a fresh id. JS code —
 * including an XSS payload — can use the key to derive session material,
 * which is all the relay handshake ever needs, but can never read the
 * raw PSK bytes back out.
 *
 * Zeroes `pskBytes` in place before returning — the trade-off this
 * accepts is that pairing can't be exported to a second browser; re-
 * pairing is a QR scan, and per-device pairing is the direction the
 * protocol is headed anyway (spec §9's `conn_id` seam).
 *
 * Returns both the storage id (save it as `AppSettings.relayPskId`) and
 * the imported key itself, so a caller configuring a `RelayTransport`
 * immediately after pairing doesn't need a round trip through IndexedDB
 * to get back something it just imported.
 */
export const savePsk = async (pskBytes: Uint8Array): Promise<{ id: string; key: CryptoKey }> => {
  const key = await importPsk(pskBytes)
  pskBytes.fill(0)
  const id = generateId()
  await putSilent<SecretRow>('relaySecrets', { key: id, value: key })
  return { id, key }
}

/** Looks up a previously-saved PSK by id. Returns `undefined` if `id` is
 * empty (no pairing configured) or not found. */
export const loadPsk = async (id: string): Promise<CryptoKey | undefined> => {
  if (!id) return undefined
  const row = await get<SecretRow>('relaySecrets', id)
  return row?.value
}

export const clearPsk = async (id: string): Promise<void> => {
  if (!id) return
  await deleteByKeySilent('relaySecrets', id)
}
