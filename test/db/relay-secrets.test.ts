// Verifies the v4 IndexedDB migration and the PSK non-extractable-key
// storage design from the build plan's Step 10, plus the v6 multi-pairing
// PSK lifecycle: settings round-trip through the schema, the PSK is stored
// as a CryptoKey that cannot be read back out as raw bytes from anywhere
// (including the console), and multiple pairings' PSKs don't step on each
// other.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPsk, loadPsk, savePsk } from '@browser/db/relay-secrets'
import { getSettings, saveSettings } from '@browser/db/settings'
import { listPairings } from '@browser/db/pairings'
import { base64UrlEncode } from '@shared/pairing-schema'

// The multi-pairing lifecycle tests below exercise relay/pairing.ts's real
// add/remove logic (dedupe, PSK ordering) but stub out the transport layer
// underneath it — configureRelay() would otherwise open a real WebSocket
// to a relay URL that doesn't exist, which these storage-focused tests
// have no business doing. vi.mock calls are hoisted above imports, so this
// takes effect before relay/pairing.ts (imported below) is evaluated.
vi.mock('@browser/relay/index', () => ({
  configureRelay: vi.fn(),
  disconnectRelay: vi.fn(),
  isRelayConfigured: vi.fn(() => false),
  reconnectRelay: vi.fn(),
  relayState: vi.fn(() => null),
  relayFetch: vi.fn(),
  onRelayStateChange: vi.fn(() => () => {})
}))

import { addPairingFromCode, removePairing } from '@browser/relay/pairing'

// fake-indexeddb persists per-database-name across tests in the same
// process; each test gets a clean slate by deleting the database first.
beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

const pairingCode = (pairId: Uint8Array, psk: Uint8Array): string =>
  `opencharui://pair?v=1&r=${encodeURIComponent('wss://relay.example.com')}&i=${base64UrlEncode(pairId)}&k=${base64UrlEncode(psk)}`

describe('settings v6: round trip', () => {
  it('defaults activePairingId to empty string', async () => {
    const settings = await getSettings()
    expect(settings.activePairingId).toBe('')
  })

  it('persists activePairingId across a fresh read', async () => {
    await saveSettings({ activePairingId: 'abc123' })
    const settings = await getSettings()
    expect(settings.activePairingId).toBe('abc123')
  })

  it('a partial save leaves unrelated fields (including pre-existing ones) untouched', async () => {
    await saveSettings({ ollamaUrl: 'http://127.0.0.1:11434', ollamaApiKey: 'token' })
    await saveSettings({ activePairingId: 'abc123' })
    const settings = await getSettings()
    expect(settings.ollamaUrl).toBe('http://127.0.0.1:11434')
    expect(settings.ollamaApiKey).toBe('token')
    expect(settings.activePairingId).toBe('abc123')
  })
})

describe('relay/pairing: multi-pairing PSK lifecycle', () => {
  it('adding a second pairing does not clear the first PSK', async () => {
    await addPairingFromCode(
      pairingCode(crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(32))),
      'Home PC'
    )
    const [first] = await listPairings()
    await addPairingFromCode(
      pairingCode(crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(32))),
      'Work laptop'
    )

    expect(await loadPsk(first!.pskId)).toBeDefined()
    const all = await listPairings()
    expect(all).toHaveLength(2)
  })

  it('removing one pairing clears only its own PSK', async () => {
    await addPairingFromCode(
      pairingCode(crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(32))),
      'Home PC'
    )
    await addPairingFromCode(
      pairingCode(crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(32))),
      'Work laptop'
    )
    const [first, second] = await listPairings()

    await removePairing(first!.id)

    expect(await loadPsk(first!.pskId)).toBeUndefined()
    expect(await loadPsk(second!.pskId)).toBeDefined()
    expect(await listPairings()).toHaveLength(1)
  })

  it('re-adding the same relay URL + pair id refreshes in place instead of duplicating', async () => {
    const pairId = crypto.getRandomValues(new Uint8Array(16))
    await addPairingFromCode(pairingCode(pairId, crypto.getRandomValues(new Uint8Array(32))), 'Home PC')
    const [before] = await listPairings()
    const oldPskId = before!.pskId

    await addPairingFromCode(pairingCode(pairId, crypto.getRandomValues(new Uint8Array(32))))
    const all = await listPairings()

    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe(before!.id)
    // The label is kept, not reset to the hostname fallback, since no new
    // label was passed on the refresh.
    expect(all[0]!.label).toBe('Home PC')
    // The old PSK row is orphaned and cleared; the refreshed one is present.
    expect(await loadPsk(oldPskId)).toBeUndefined()
    expect(await loadPsk(all[0]!.pskId)).toBeDefined()
  })
})

describe('relay-secrets: PSK storage', () => {
  it('round-trips a PSK through IndexedDB as a usable CryptoKey', async () => {
    const psk = crypto.getRandomValues(new Uint8Array(32))
    const { id } = await savePsk(psk.slice()) // slice: savePsk zeroes its argument in place

    const key = await loadPsk(id)
    expect(key).toBeDefined()
    expect(key).toBeInstanceOf(CryptoKey)

    // Actually usable for what the handshake needs: deriving bits via HKDF.
    const derived = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('test') },
      key!,
      256
    )
    expect(new Uint8Array(derived).length).toBe(32)
  })

  it('stores the key as non-extractable — exportKey must reject', async () => {
    const psk = crypto.getRandomValues(new Uint8Array(32))
    const { id } = await savePsk(psk.slice())
    const key = await loadPsk(id)

    expect(key!.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow()
  })

  it('zeroes the caller-supplied buffer after import — the raw bytes do not linger in JS-visible memory', async () => {
    const psk = crypto.getRandomValues(new Uint8Array(32))
    const original = psk.slice()
    await savePsk(psk)
    expect(psk.every((b) => b === 0)).toBe(true)
    expect(psk).not.toEqual(original)
  })

  it('loadPsk on an empty id returns undefined (no pairing configured)', async () => {
    expect(await loadPsk('')).toBeUndefined()
  })

  it('loadPsk on an unknown id returns undefined', async () => {
    expect(await loadPsk('never-saved')).toBeUndefined()
  })

  it('clearPsk removes the stored key', async () => {
    const psk = crypto.getRandomValues(new Uint8Array(32))
    const { id } = await savePsk(psk)
    expect(await loadPsk(id)).toBeDefined()

    await clearPsk(id)
    expect(await loadPsk(id)).toBeUndefined()
  })

  it('two different PSKs derive different session material', async () => {
    const { id: idA } = await savePsk(crypto.getRandomValues(new Uint8Array(32)))
    const { id: idB } = await savePsk(crypto.getRandomValues(new Uint8Array(32)))
    const keyA = await loadPsk(idA)
    const keyB = await loadPsk(idB)

    const deriveFrom = (k: CryptoKey) =>
      crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('x') },
        k,
        256
      )
    const a = new Uint8Array(await deriveFrom(keyA!))
    const b = new Uint8Array(await deriveFrom(keyB!))
    expect(a).not.toEqual(b)
  })
})
