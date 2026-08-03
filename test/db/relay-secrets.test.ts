// Verifies the v4 IndexedDB migration and the PSK non-extractable-key
// storage design from the build plan's Step 10: settings round-trip
// through the new schema, and the PSK is stored as a CryptoKey that
// cannot be read back out as raw bytes from anywhere, including the
// console.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPsk, loadPsk, savePsk } from '@browser/db/relay-secrets'
import { getSettings, saveSettings } from '@browser/db/settings'

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

describe('settings v4: round trip', () => {
  it('defaults every relay field to empty string', async () => {
    const settings = await getSettings()
    expect(settings.relayUrl).toBe('')
    expect(settings.relayPairId).toBe('')
    expect(settings.relayPskId).toBe('')
  })

  it('persists relayUrl/relayPairId/relayPskId across a fresh read', async () => {
    await saveSettings({ relayUrl: 'wss://relay.example.com', relayPairId: 'abc123', relayPskId: 'deadbeef' })
    const settings = await getSettings()
    expect(settings.relayUrl).toBe('wss://relay.example.com')
    expect(settings.relayPairId).toBe('abc123')
    expect(settings.relayPskId).toBe('deadbeef')
  })

  it('a partial save leaves unrelated fields (including pre-existing ones) untouched', async () => {
    await saveSettings({ ollamaUrl: 'http://127.0.0.1:11434', ollamaApiKey: 'token' })
    await saveSettings({ relayUrl: 'wss://relay.example.com' })
    const settings = await getSettings()
    expect(settings.ollamaUrl).toBe('http://127.0.0.1:11434')
    expect(settings.ollamaApiKey).toBe('token')
    expect(settings.relayUrl).toBe('wss://relay.example.com')
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
