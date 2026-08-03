// High-level pairing operations layered on top of relay/index.ts's
// transport singleton, db/relay-secrets.ts's non-extractable PSK storage,
// and db/settings.ts. This is what PairingPanel.vue and the `relay`
// namespace in browser/api.ts call — neither talks to configureRelay()
// or savePsk() directly.
import { base64UrlDecode, base64UrlEncode, parsePairingCode } from '@shared/pairing-schema'
import { getSettings, saveSettings } from '../db/settings'
import { clearPsk, loadPsk, savePsk } from '../db/relay-secrets'
import { invalidateOllamaBaseUrl } from '../llm/ollama'
import { configureRelay, disconnectRelay, isRelayConfigured } from './index'

/** Parses a scanned/pasted pairing code, persists the PSK (as a
 * non-extractable CryptoKey) and the relay settings, and connects. Any
 * previous pairing is replaced. */
export const pairWithCode = async (raw: string): Promise<void> => {
  const parsed = parsePairingCode(raw)
  const { id: pskId, key } = await savePsk(parsed.psk)

  const previous = await getSettings()
  await saveSettings({
    relayUrl: parsed.relayUrl,
    relayPairId: base64UrlEncode(parsed.pairId),
    relayPskId: pskId
  })
  // Drop the now-orphaned previous secret row, if any, after the new one
  // is safely saved — never the other way around.
  if (previous.relayPskId && previous.relayPskId !== pskId) {
    await clearPsk(previous.relayPskId)
  }

  configureRelay({ relayUrl: parsed.relayUrl, pairId: parsed.pairId, psk: key })
  invalidateOllamaBaseUrl()
}

/** Disconnects and forgets the current pairing. */
export const unpair = async (): Promise<void> => {
  const settings = await getSettings()
  disconnectRelay()
  if (settings.relayPskId) await clearPsk(settings.relayPskId)
  await saveSettings({ relayUrl: '', relayPairId: '', relayPskId: '' })
  invalidateOllamaBaseUrl()
}

/** True when pairing settings are present, regardless of live connection
 * state — used to decide whether to show "paired" vs. the scan/paste UI. */
export const isPaired = async (): Promise<boolean> => {
  const settings = await getSettings()
  return Boolean(settings.relayUrl && settings.relayPairId && settings.relayPskId)
}

/** Idempotent bootstrap: if settings describe a pairing but the transport
 * singleton hasn't been configured yet in this page session (e.g. after a
 * reload), reconnect from stored settings + the persisted PSK. Safe to
 * call on every `resolveConnection()` — a no-op once configured. */
export const ensureRelayConfigured = async (): Promise<void> => {
  if (isRelayConfigured()) return
  const settings = await getSettings()
  if (!settings.relayUrl || !settings.relayPairId || !settings.relayPskId) return

  const key = await loadPsk(settings.relayPskId)
  if (!key) return // secret row missing/cleared — treat as unpaired

  const pairId = base64UrlDecode(settings.relayPairId)
  configureRelay({ relayUrl: settings.relayUrl, pairId, psk: key })
}
