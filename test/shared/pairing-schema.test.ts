import { describe, expect, it } from 'vitest'
import { parsePairingCode } from '@shared/pairing-schema'

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeUri(overrides: Partial<{ v: string; r: string; i: string; k: string }> = {}): string {
  const pairId = b64url(new Uint8Array(16).fill(1))
  const psk = b64url(new Uint8Array(32).fill(2))
  const params = {
    v: '1',
    r: 'wss://relay.opencharui.com',
    i: pairId,
    k: psk,
    ...overrides
  }
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&')
  return `opencharui://pair?${qs}`
}

describe('parsePairingCode: happy path', () => {
  it('parses a full opencharui://pair URI', () => {
    const uri = makeUri()
    const result = parsePairingCode(uri)
    expect(result.version).toBe(1)
    expect(result.relayUrl).toBe('wss://relay.opencharui.com')
    expect(result.pairId).toHaveLength(16)
    expect(result.psk).toHaveLength(32)
    expect(Array.from(result.pairId)).toEqual(Array.from(new Uint8Array(16).fill(1)))
    expect(Array.from(result.psk)).toEqual(Array.from(new Uint8Array(32).fill(2)))
  })

  it('accepts a bare query string without the opencharui:// prefix (manual paste)', () => {
    const uri = makeUri()
    const bareQuery = uri.split('?')[1]
    const result = parsePairingCode(bareQuery)
    expect(result.relayUrl).toBe('wss://relay.opencharui.com')
  })

  it('accepts a ws:// (non-TLS) relay URL for local dev', () => {
    const result = parsePairingCode(makeUri({ r: 'ws://127.0.0.1:8080' }))
    expect(result.relayUrl).toBe('ws://127.0.0.1:8080')
  })

  it('trims surrounding whitespace (paste artifacts)', () => {
    const result = parsePairingCode(`  ${makeUri()}  \n`)
    expect(result.version).toBe(1)
  })
})

describe('parsePairingCode: rejects malformed input', () => {
  it('rejects empty input', () => {
    expect(() => parsePairingCode('')).toThrow()
    expect(() => parsePairingCode('   ')).toThrow()
  })

  it('rejects a non-pairing URL', () => {
    expect(() => parsePairingCode('https://example.com')).toThrow(/not.*opencharui/i)
  })

  it('rejects an unsupported version', () => {
    expect(() => parsePairingCode(makeUri({ v: '2' }))).toThrow(/version/i)
  })

  it('rejects a missing relay url', () => {
    expect(() => parsePairingCode(makeUri({ r: undefined }))).toThrow(/relay/i)
  })

  it('rejects a relay url that is not ws:// or wss://', () => {
    expect(() => parsePairingCode(makeUri({ r: 'http://relay.example.com' }))).toThrow()
  })

  it('rejects a pair id that decodes to the wrong length', () => {
    const shortId = b64url(new Uint8Array(8))
    expect(() => parsePairingCode(makeUri({ i: shortId }))).toThrow(/16 bytes/)
  })

  it('rejects a psk that decodes to the wrong length', () => {
    const shortPsk = b64url(new Uint8Array(16))
    expect(() => parsePairingCode(makeUri({ k: shortPsk }))).toThrow(/32 bytes/)
  })

  it('rejects invalid base64url', () => {
    expect(() => parsePairingCode(makeUri({ i: '!!!not-base64!!!' }))).toThrow()
  })

  it('rejects a missing pair id', () => {
    expect(() => parsePairingCode(makeUri({ i: undefined }))).toThrow(/pair id/i)
  })

  it('rejects a missing secret', () => {
    expect(() => parsePairingCode(makeUri({ k: undefined }))).toThrow(/secret/i)
  })
})
