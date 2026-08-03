// The transport singleton ollama.ts and device-sync.ts share, plus a
// pre-bound relayFetch. Pairing/settings storage (IndexedDB v4,
// PairingPanel.vue) lands in later steps — until something calls
// configureRelay(), the relay transport simply doesn't exist, and
// isRelayConfigured()/resolveConnection() fall back to the direct
// transport (see ollama.ts).
import { createRelayFetch } from './fetch'
import { RelayTransport, type PairingInfo, type RelayState, type SocketFactory } from './transport'

let transport: RelayTransport | null = null
let unsubscribeFromTransport: (() => void) | null = null

// Module-level so a subscriber (e.g. PairingPanel.vue, mounted before
// pairing exists) keeps receiving updates across configureRelay()/
// disconnectRelay() calls rather than being tied to one transport instance.
const globalListeners = new Set<(s: RelayState | null) => void>()

function notifyAll(s: RelayState | null): void {
  for (const cb of globalListeners) cb(s)
}

export function configureRelay(pairing: PairingInfo, socketFactory?: SocketFactory): RelayTransport {
  transport?.close()
  unsubscribeFromTransport?.()
  transport = socketFactory ? new RelayTransport(pairing, socketFactory) : new RelayTransport(pairing)
  unsubscribeFromTransport = transport.onStateChange(notifyAll)
  notifyAll(transport.getState())
  return transport
}

export function isRelayConfigured(): boolean {
  return transport !== null
}

export function disconnectRelay(): void {
  transport?.close()
  unsubscribeFromTransport?.()
  unsubscribeFromTransport = null
  transport = null
  notifyAll(null)
}

function getTransport(): RelayTransport {
  if (!transport) throw new Error('relay: not configured — call configureRelay() first')
  return transport
}

export const relayFetch = createRelayFetch(getTransport)

export function relayState(): RelayState | null {
  return transport?.getState() ?? null
}

export function onRelayStateChange(cb: (s: RelayState | null) => void): () => void {
  globalListeners.add(cb)
  return () => globalListeners.delete(cb)
}

export type { PairingInfo, RelayState, WebSocketLike, SocketFactory } from './transport'
