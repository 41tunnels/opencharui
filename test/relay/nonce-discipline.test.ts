// Spec §5.1: one direction, one key, one counter, and therefore exactly
// one sealing point. These are the tests for that rule holding under
// concurrency, which is the only condition that can break it — a single
// request in flight cannot race anything.
//
// The regression they pin: `Sealer.seal()` awaits WebCrypto, and
// `relayFetch` runs one task chain per in-flight request. Reading the
// counter before that await and incrementing after it handed the same
// counter to every send that started while another was suspended, so a
// page issuing four requests at once put four frames on the wire under
// counter 0 — an AES-GCM nonce reuse, and a guaranteed
// `counter_mismatch` at the agent, which drops the agent's whole relay
// connection (relay close 4410 `agent_gone`) rather than just the
// request. Observed against the live relay as "pairing takes several
// tries", because the reconnect only succeeds once the retried requests
// happen to stop overlapping.
import { describe, expect, it } from 'vitest'
import { importPsk } from '@browser/relay/crypto'
import { createRelayFetch } from '@browser/relay/fetch'
import { RelayTransport, type PairingInfo, type WebSocketLike } from '@browser/relay/transport'
import { Channel, InnerType, parseOuter } from '@browser/relay/wire'
import { MockAgentSocket, type EmitFn, type MockRequest } from './mock-agent-socket'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** The 8-byte big-endian counter every channel-0x01 payload carries in
 * the clear (spec §5), so a test can check nonce discipline without any
 * of the keys. */
function counterOf(payload: Uint8Array): number {
  let v = 0
  for (let i = 0; i < 8; i++) v = v * 256 + payload[i]
  return v
}

/** Wraps the mock agent so every frame the client puts on the wire is
 * recorded before it reaches the other side. */
function recordingSocket(inner: MockAgentSocket, sentCounters: number[]): WebSocketLike {
  return {
    get readyState() {
      return inner.readyState
    },
    send(data: ArrayBufferLike | ArrayBufferView): void {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
      const { header, payload } = parseOuter(bytes)
      if (header.channel === Channel.Ciphertext) sentCounters.push(counterOf(payload))
      inner.send(bytes)
    },
    close: () => inner.close(),
    addEventListener: (t, l) => inner.addEventListener(t, l),
    removeEventListener: (t, l) => inner.removeEventListener(t, l)
  }
}

async function setup(handler: (req: MockRequest, emit: EmitFn) => void | Promise<void>) {
  const pairing: PairingInfo = {
    relayUrl: 'ws://relay.invalid',
    pairId: randomBytes(16),
    psk: await importPsk(randomBytes(32))
  }
  const sentCounters: number[] = []
  const transport = new RelayTransport(pairing, () =>
    recordingSocket(new MockAgentSocket(pairing.psk, pairing.pairId, handler), sentCounters)
  )
  return { transport, relayFetch: createRelayFetch(() => transport), sentCounters }
}

const ok: (req: MockRequest, emit: EmitFn) => Promise<void> = async (req, emit) => {
  await emit({
    type: InnerType.Resp,
    payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [] }))
  })
  await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode(req.path) })
  await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
}

describe('relay nonce discipline (spec §5.1)', () => {
  it('seals concurrent requests under strictly sequential counters', async () => {
    const { transport, relayFetch, sentCounters } = await setup(ok)

    // Fired without awaiting in between — the shape `fetchTags()`, the
    // sync engine and the model list produce on a fresh session. The
    // responses are deliberately not awaited: with the counters wrong the
    // agent never answers at all, and this test is about what went onto
    // the wire, not about recovering from it.
    const paths = ['/api/tags', '/api/version', '/api/ps', '/api/sync']
    void Promise.all(paths.map((p) => relayFetch(p, { method: 'GET' }).catch(() => undefined)))

    // Every request is at least REQ + REQ_END, so there is real overlap
    // to get wrong here.
    // Real timer ticks, not microtasks: the handshake ahead of these
    // frames is genuine WebCrypto, which does not settle on a microtask
    // drain.
    const want = paths.length * 2
    for (let i = 0; i < 400 && sentCounters.length < want; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(sentCounters.length).toBeGreaterThanOrEqual(want)
    expect(new Set(sentCounters).size).toBe(sentCounters.length)
    expect(sentCounters).toEqual(sentCounters.map((_, i) => i))

    // The requests above are deliberately left in flight; closing stops
    // the mock answering into a test that has already finished.
    transport.close()
  })

  it('completes every concurrent request rather than failing the peer', async () => {
    const { transport, relayFetch } = await setup(ok)

    const paths = ['/api/tags', '/api/version', '/api/ps', '/api/show', '/api/sync']
    const responses = await Promise.all(paths.map((p) => relayFetch(p, { method: 'GET' })))

    expect(responses.map((r) => r.status)).toEqual(paths.map(() => 200))
    // Bodies echo the path, so a mismatch would mean frames from two
    // streams were interleaved into the wrong order on the way out.
    const bodies = await Promise.all(responses.map((r) => r.text()))
    expect(bodies).toEqual(paths)

    transport.close()
  })
})
