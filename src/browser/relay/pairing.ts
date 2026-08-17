// High-level pairing operations layered on top of relay/index.ts's
// transport singleton, db/relay-secrets.ts's non-extractable PSK storage,
// and db/pairings.ts's saved-pairings list. This is what PairingPanel.vue
// and the `relay` namespace in browser/api.ts call — neither talks to
// configureRelay() or savePsk() directly.
import { base64UrlDecode, base64UrlEncode, parsePairingCode } from '@shared/pairing-schema'
import type { RelayPairingSummary, StoredPairing } from '@shared/types'
import { clearPsk, loadPsk, savePsk } from '../db/relay-secrets'
import {
  addPairing,
  getActivePairingId,
  getPairing,
  listPairings,
  removePairing as removePairingRow,
  setActivePairingId,
  updatePairing
} from '../db/pairings'
import { invalidateOllamaBaseUrl } from '../llm/ollama'
import { configureRelay, disconnectRelay, isRelayConfigured } from './index'

const connectTo = (row: StoredPairing, key: CryptoKey): void => {
  configureRelay({ relayUrl: row.relayUrl, pairId: base64UrlDecode(row.pairId), psk: key })
}

const hostnameLabel = (relayUrl: string): string => {
  try {
    return new URL(relayUrl).hostname || relayUrl
  } catch {
    return relayUrl
  }
}

/**
 * Parses a scanned/pasted pairing code and either adds a new saved pairing
 * or, if one already exists for the same relay URL + pair id, refreshes its
 * PSK in place (a re-scan of the same amallo instance is a refresh, not a
 * second device — its label is kept unless `label` overrides it). The
 * result is made active and connected. `label` is optional; when omitted
 * or blank on a new pairing, it defaults to the relay URL's hostname.
 */
export const addPairingFromCode = async (raw: string, label?: string): Promise<void> => {
  const parsed = parsePairingCode(raw)
  const relayUrl = parsed.relayUrl
  const pairId = base64UrlEncode(parsed.pairId)
  const trimmedLabel = label?.trim() ?? ''

  const { id: pskId, key } = await savePsk(parsed.psk)

  const existing = (await listPairings()).find((p) => p.relayUrl === relayUrl && p.pairId === pairId)

  let row: StoredPairing
  if (existing) {
    const oldPskId = existing.pskId
    row = (await updatePairing(existing.id, {
      pskId,
      ...(trimmedLabel ? { label: trimmedLabel } : {})
    })) as StoredPairing
    // Drop the now-orphaned previous secret row after the new one is
    // safely saved — never the other way around.
    if (oldPskId && oldPskId !== pskId) await clearPsk(oldPskId)
  } else {
    row = await addPairing({
      label: trimmedLabel || hostnameLabel(relayUrl),
      relayUrl,
      pairId,
      pskId
    })
  }

  await setActivePairingId(row.id)
  connectTo(row, key)
  invalidateOllamaBaseUrl()
}

/** Switches the active pairing and connects to it. No-op (beyond
 * reconnecting) if `id` is already active. */
export const setActivePairing = async (id: string): Promise<void> => {
  const row = await getPairing(id)
  if (!row) throw new Error('relay: no saved pairing with that id')

  const key = await loadPsk(row.pskId)
  if (!key) throw new Error('relay: this pairing\'s secret is missing — remove and re-pair it')

  await setActivePairingId(id)
  connectTo(row, key)
  invalidateOllamaBaseUrl()
}

export const renamePairing = async (id: string, label: string): Promise<void> => {
  const trimmed = label.trim()
  if (!trimmed) return
  await updatePairing(id, { label: trimmed })
}

/** Removes a saved pairing and its PSK. If it was active, disconnects and
 * promotes another saved pairing (if any) to active; otherwise leaves the
 * app unpaired. */
export const removePairing = async (id: string): Promise<void> => {
  const [row, activeId] = await Promise.all([getPairing(id), getActivePairingId()])
  if (!row) return

  const wasActive = activeId === id
  if (wasActive) disconnectRelay()

  await removePairingRow(id)
  await clearPsk(row.pskId)

  if (!wasActive) return

  const remaining = await listPairings()
  const next = remaining[0]
  if (next) {
    await setActivePairing(next.id)
  } else {
    await setActivePairingId('')
    invalidateOllamaBaseUrl()
  }
}

export const getSavedPairing = (id: string): Promise<StoredPairing | undefined> => getPairing(id)

export const listSavedPairings = async (): Promise<RelayPairingSummary[]> => {
  const [rows, activeId] = await Promise.all([listPairings(), getActivePairingId()])
  return rows
    .slice()
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((row) => ({ id: row.id, label: row.label, relayUrl: row.relayUrl, active: row.id === activeId }))
}

/** True when a pairing is saved and active, regardless of live connection
 * state — used to decide whether to show "paired" vs. the scan/paste UI. */
export const isPaired = async (): Promise<boolean> => {
  const activeId = await getActivePairingId()
  return Boolean(activeId)
}

/** Idempotent bootstrap: if an active pairing is saved but the transport
 * singleton hasn't been configured yet in this page session (e.g. after a
 * reload), reconnect from it and its persisted PSK. Safe to call on every
 * `resolveConnection()` — a no-op once configured. */
export const ensureRelayConfigured = async (): Promise<void> => {
  if (isRelayConfigured()) return
  const activeId = await getActivePairingId()
  if (!activeId) return

  const row = await getPairing(activeId)
  if (!row) return // saved pairing missing/removed — treat as unpaired

  const key = await loadPsk(row.pskId)
  if (!key) return // secret row missing/cleared — treat as unpaired

  connectTo(row, key)
}
