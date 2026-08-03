// Validates src/browser/relay/crypto.ts against the shared cross-language
// vectors vendored from the relay repo (test/vectors/) — the same files
// the Go reference implementation and (once Step 5 lands) the Rust
// implementation check themselves against. Agreement here means: given
// the same deterministic ephemeral keys, nonces, and PSK, this WebCrypto
// implementation derives byte-identical session keys, HELLO/CONFIRM
// frames, and AEAD ciphertexts as Go's `internal/proto`.
import { describe, expect, it } from 'vitest'
import {
  HandshakeError,
  Opener,
  Role,
  Sealer,
  buildConfirm,
  buildHello,
  deriveSession,
  ecdh,
  ephemeralFromScalarAndPublicKey,
  generateEphemeral,
  importPsk,
  kMac,
  pskIkm,
  transcript as computeTranscript,
  verifyConfirm,
  verifyHello
} from '@browser/relay/crypto'
import { decodeInnerAll } from '@browser/relay/wire'

import handshakeVectors from '../vectors/handshake.json'
import aeadVectors from '../vectors/aead.json'
import sessionVectorJson from '../vectors/session.json'

function hexDecode(s: string): Uint8Array {
  if (!s) return new Uint8Array(0)
  const bytes = new Uint8Array(s.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function expectHandshakeError(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HandshakeError)
  expect((caught as HandshakeError).code).toBe(code)
}

interface HandshakeExpected {
  k_mac_hex: string
  agent_epk_hex: string
  web_epk_hex: string
  hello_agent_hex: string
  hello_web_hex: string
  transcript_hex: string
  ecdh_x_hex: string
  psk_ikm_hex: string
  k_a2w_hex: string
  k_w2a_hex: string
  np_a2w_hex: string
  np_w2a_hex: string
  confirm_agent_hex: string
  confirm_web_hex: string
}

interface HandshakeCase {
  name: string
  inputs: {
    pair_id_hex?: string
    psk_hex: string
    agent_eph_priv_raw_hex?: string
    web_eph_priv_raw_hex?: string
    agent_nonce_hex?: string
    web_nonce_hex?: string
  }
  expected?: HandshakeExpected
  expect_error?: string
  verify_raw_hello_hex?: string
  verify_own_role_hex?: string
  verify_pair_id_hex?: string
}

describe('crypto vectors: handshake', () => {
  const cases = handshakeVectors as HandshakeCase[]

  for (const c of cases) {
    it(c.name, async () => {
      const psk = await importPsk(hexDecode(c.inputs.psk_hex))

      // Negative / targeted verify-only cases feed a raw (possibly
      // tampered) HELLO straight to verifyHello.
      if (c.verify_raw_hello_hex !== undefined) {
        const pairId = hexDecode(c.verify_pair_id_hex ?? '')
        const ownRole = hexDecode(c.verify_own_role_hex ?? '')[0]
        const raw = hexDecode(c.verify_raw_hello_hex)
        if (c.expect_error) {
          await expectHandshakeError(() => verifyHello(psk, raw, pairId, ownRole), c.expect_error)
          return
        }
        await verifyHello(psk, raw, pairId, ownRole)
        return
      }

      // Full positive derivation case.
      const exp = c.expected
      if (!exp) throw new Error(`case ${c.name}: missing "expected"`)

      const pairId = hexDecode(c.inputs.pair_id_hex ?? '')
      const agentEph = await ephemeralFromScalarAndPublicKey(
        hexDecode(c.inputs.agent_eph_priv_raw_hex ?? ''),
        hexDecode(exp.agent_epk_hex)
      )
      const webEph = await ephemeralFromScalarAndPublicKey(
        hexDecode(c.inputs.web_eph_priv_raw_hex ?? ''),
        hexDecode(exp.web_epk_hex)
      )
      const agentNonce = hexDecode(c.inputs.agent_nonce_hex ?? '')
      const webNonce = hexDecode(c.inputs.web_nonce_hex ?? '')

      expect(hexEncode(await kMac(psk))).toBe(exp.k_mac_hex)
      expect(hexEncode(agentEph.publicKeyBytes)).toBe(exp.agent_epk_hex)
      expect(hexEncode(webEph.publicKeyBytes)).toBe(exp.web_epk_hex)

      const helloAgent = await buildHello(psk, Role.Agent, pairId, agentEph.publicKeyBytes, agentNonce)
      const helloWeb = await buildHello(psk, Role.Client, pairId, webEph.publicKeyBytes, webNonce)
      expect(hexEncode(helloAgent)).toBe(exp.hello_agent_hex)
      expect(hexEncode(helloWeb)).toBe(exp.hello_web_hex)

      await verifyHello(psk, helloWeb, pairId, Role.Agent)
      await verifyHello(psk, helloAgent, pairId, Role.Client)

      const t = await computeTranscript(helloAgent, helloWeb)
      expect(hexEncode(t)).toBe(exp.transcript_hex)

      const ecdhX = await ecdh(agentEph.privateKey, webEph.publicKeyBytes)
      expect(hexEncode(ecdhX)).toBe(exp.ecdh_x_hex)

      expect(hexEncode(await pskIkm(psk, t))).toBe(exp.psk_ikm_hex)

      const session = await deriveSession(psk, t, ecdhX)
      expect(hexEncode(session.kA2W)).toBe(exp.k_a2w_hex)
      expect(hexEncode(session.kW2A)).toBe(exp.k_w2a_hex)
      expect(hexEncode(session.npA2W)).toBe(exp.np_a2w_hex)
      expect(hexEncode(session.npW2A)).toBe(exp.np_w2a_hex)

      const confirmAgent = await buildConfirm(session, Role.Agent)
      const confirmWeb = await buildConfirm(session, Role.Client)
      expect(hexEncode(confirmAgent)).toBe(exp.confirm_agent_hex)
      expect(hexEncode(confirmWeb)).toBe(exp.confirm_web_hex)

      await verifyConfirm(session, confirmAgent, Role.Agent)
      await verifyConfirm(session, confirmWeb, Role.Client)
    })
  }
})

interface AeadCase {
  name: string
  key_hex: string
  prefix_hex: string
  header_hex: string
  counter: number
  plaintext_hex?: string
  ciphertext_payload_hex?: string
  expect_error?: string
}

describe('crypto vectors: aead', () => {
  const cases = aeadVectors as AeadCase[]

  for (const c of cases) {
    it(c.name, async () => {
      const key = hexDecode(c.key_hex)
      const prefix = hexDecode(c.prefix_hex)
      const header = hexDecode(c.header_hex)

      if (c.expect_error) {
        const opener = await Opener.createAt(key, prefix, 0n)
        await expectHandshakeError(
          () => opener.open(header, hexDecode(c.ciphertext_payload_hex ?? '')),
          c.expect_error
        )
        return
      }

      const sealer = await Sealer.createAt(key, prefix, BigInt(c.counter))
      const ct = await sealer.seal(header, hexDecode(c.plaintext_hex ?? ''))
      expect(hexEncode(ct)).toBe(c.ciphertext_payload_hex)

      const opener = await Opener.createAt(key, prefix, BigInt(c.counter))
      const pt = await opener.open(header, ct)
      expect(hexEncode(pt)).toBe(c.plaintext_hex ?? '')
    })
  }
})

interface SessionFrame {
  dir: 'a2w' | 'w2a'
  inner_hex: string
  ciphertext_hex: string
}
interface SessionVector {
  name: string
  k_a2w_hex: string
  k_w2a_hex: string
  np_a2w_hex: string
  np_w2a_hex: string
  frames: SessionFrame[]
}

describe('crypto vectors: session (golden chat transcript)', () => {
  const v = sessionVectorJson as SessionVector

  it(v.name, async () => {
    const openerA2W = await Opener.create(hexDecode(v.k_a2w_hex), hexDecode(v.np_a2w_hex))
    const openerW2A = await Opener.create(hexDecode(v.k_w2a_hex), hexDecode(v.np_w2a_hex))
    const header = new Uint8Array([0x01, 0x00])

    let sawStream1 = false
    for (const f of v.frames) {
      const opener = f.dir === 'a2w' ? openerA2W : openerW2A
      const pt = await opener.open(header, hexDecode(f.ciphertext_hex))
      expect(hexEncode(pt)).toBe(f.inner_hex)

      const frames = decodeInnerAll(pt)
      expect(frames).toHaveLength(1)
      if (frames[0].streamId === 1) sawStream1 = true
    }
    expect(sawStream1).toBe(true)
  })
})

describe('crypto: hand-written checks', () => {
  it('seal/open round trip with a fresh session', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const prefix = crypto.getRandomValues(new Uint8Array(4))
    const sealer = await Sealer.create(key, prefix)
    const opener = await Opener.create(key, prefix)
    const header = new Uint8Array([0x01, 0x00])

    for (const text of ['', 'a', 'x'.repeat(1000)]) {
      const pt = new TextEncoder().encode(text)
      const ct = await sealer.seal(header, pt)
      const got = await opener.open(header, ct)
      expect(new TextDecoder().decode(got)).toBe(text)
    }
  })

  it('rejects a tampered ciphertext', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const prefix = crypto.getRandomValues(new Uint8Array(4))
    const sealer = await Sealer.create(key, prefix)
    const opener = await Opener.create(key, prefix)
    const header = new Uint8Array([0x01, 0x00])

    const ct = await sealer.seal(header, new TextEncoder().encode('authentic'))
    const tampered = ct.slice()
    tampered[tampered.length - 1] ^= 0x01
    await expectHandshakeError(() => opener.open(header, tampered), 'auth_failed')
  })

  it('rejects a counter replay', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const prefix = crypto.getRandomValues(new Uint8Array(4))
    const sealer = await Sealer.create(key, prefix)
    const opener = await Opener.create(key, prefix)
    const header = new Uint8Array([0x01, 0x00])

    const ct = await sealer.seal(header, new TextEncoder().encode('only frame'))
    await opener.open(header, ct)
    await expectHandshakeError(() => opener.open(header, ct), 'counter_mismatch')
  })

  it('full handshake between two independently generated ephemeral pairs agrees on session keys', async () => {
    const psk = await importPsk(crypto.getRandomValues(new Uint8Array(32)))
    const pairId = crypto.getRandomValues(new Uint8Array(16))
    const agentEph = await generateEphemeral()
    const webEph = await generateEphemeral()
    const agentNonce = crypto.getRandomValues(new Uint8Array(32))
    const webNonce = crypto.getRandomValues(new Uint8Array(32))

    const helloAgent = await buildHello(psk, Role.Agent, pairId, agentEph.publicKeyBytes, agentNonce)
    const helloWeb = await buildHello(psk, Role.Client, pairId, webEph.publicKeyBytes, webNonce)

    await verifyHello(psk, helloWeb, pairId, Role.Agent)
    await verifyHello(psk, helloAgent, pairId, Role.Client)

    const t = await computeTranscript(helloAgent, helloWeb)
    const agentX = await ecdh(agentEph.privateKey, webEph.publicKeyBytes)
    const webX = await ecdh(webEph.privateKey, agentEph.publicKeyBytes)
    expect(hexEncode(agentX)).toBe(hexEncode(webX))

    const agentSession = await deriveSession(psk, t, agentX)
    const webSession = await deriveSession(psk, t, webX)
    expect(hexEncode(agentSession.kA2W)).toBe(hexEncode(webSession.kA2W))
    expect(hexEncode(agentSession.kW2A)).toBe(hexEncode(webSession.kW2A))

    const confirmAgent = await buildConfirm(agentSession, Role.Agent)
    await verifyConfirm(webSession, confirmAgent, Role.Agent)
  })
})
