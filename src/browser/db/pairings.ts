// Storage for saved relay pairings — the `pairings` IndexedDB store (v6).
// A pairing row is connectivity metadata (relay URL, pair id, a pointer to
// its PSK row in `relaySecrets`) plus a user-facing label; the currently
// active one is tracked separately as `AppSettings.activePairingId` (see
// db/settings.ts). relay/pairing.ts is the only caller — it layers the
// actual connect/disconnect/dedupe logic on top of these plain CRUD ops.
import { deleteByKeySilent, get, getAll, putSilent } from './index'
import { getSettings, saveSettings } from './settings'
import type { StoredPairing } from '@shared/types'

/** Matches db/relay-secrets.ts's `generateId()` — not a security value,
 * just an indirection so pairing ids aren't hand-assigned. */
const generateId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const listPairings = (): Promise<StoredPairing[]> => getAll<StoredPairing>('pairings')

export const getPairing = (id: string): Promise<StoredPairing | undefined> => {
  if (!id) return Promise.resolve(undefined)
  return get<StoredPairing>('pairings', id)
}

export interface NewPairing {
  label: string
  relayUrl: string
  pairId: string
  pskId: string
}

/** Inserts a new row with a fresh id. Callers decide dedupe/refresh
 * semantics (see relay/pairing.ts) — this always adds. */
export const addPairing = async (input: NewPairing): Promise<StoredPairing> => {
  const row: StoredPairing = { id: generateId(), addedAt: Date.now(), ...input }
  await putSilent('pairings', row)
  return row
}

export const updatePairing = async (
  id: string,
  patch: Partial<Omit<StoredPairing, 'id' | 'addedAt'>>
): Promise<StoredPairing | undefined> => {
  const existing = await getPairing(id)
  if (!existing) return undefined
  const next: StoredPairing = { ...existing, ...patch }
  await putSilent('pairings', next)
  return next
}

export const removePairing = (id: string): Promise<void> => deleteByKeySilent('pairings', id)

export const getActivePairingId = async (): Promise<string> => {
  const settings = await getSettings()
  return settings.activePairingId
}

export const setActivePairingId = async (id: string): Promise<void> => {
  await saveSettings({ activePairingId: id })
}
