import { describe, expect, it } from 'vitest'
import { EMPTY_HASH, sha256Hex, sha256HexBytes } from '@browser/sync/hash'

describe('sync/hash', () => {
  it('EMPTY_HASH matches SHA-256 of the empty string (and amallo\'s store::hash::EMPTY_HASH)', async () => {
    expect(await sha256Hex('')).toBe(EMPTY_HASH)
  })

  it('is deterministic for the same input', async () => {
    const a = await sha256Hex('{"name":"Ada"}')
    const b = await sha256Hex('{"name":"Ada"}')
    expect(a).toBe(b)
  })

  it('differs for different input', async () => {
    const a = await sha256Hex('{"name":"Ada"}')
    const b = await sha256Hex('{"name":"Bea"}')
    expect(a).not.toBe(b)
  })

  it('is 64 lowercase hex characters', async () => {
    const h = await sha256Hex('anything')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sha256HexBytes agrees with sha256Hex over the equivalent UTF-8 text', async () => {
    const text = 'hello world'
    const bytes = new TextEncoder().encode(text)
    expect(await sha256HexBytes(bytes)).toBe(await sha256Hex(text))
  })

  it('serializing the same object reference twice produces byte-identical text — the ' +
    'assumption engine.ts relies on instead of a canonicalizer', () => {
    const obj = { b: 1, a: { z: [1, 2, 3], y: 'x' } }
    expect(JSON.stringify(obj)).toBe(JSON.stringify(obj))
  })
})
