// A session breaking must cost the session, not the connection.
//
// The connection outlives the session by design (spec §4.6) — Amallo
// carries the OpenAI endpoint's plain lane on the same socket, and the
// relay holds this agent's whole registration on it — so hanging up over
// one unopenable frame took all of that down and made both ends redial,
// with backoff, to arrive back where they started. Recovering in place
// costs a single handshake round trip and nothing else notices.
//
// Requests that were in flight when the session broke are still failed:
// the peer builds a fresh dispatcher per session and can never answer
// them. That is the caller's cue to retry, and is what these tests model.
import { describe, expect, it } from 'vitest'
import { importPsk } from '@browser/relay/crypto'
import { createRelayFetch } from '@browser/relay/fetch'
import { RelayTransport, type PairingInfo, type RelayState } from '@browser/relay/transport'
import { InnerType } from '@browser/relay/wire'
import { MockAgentSocket, type EmitFn, type MockRequest } from './mock-agent-socket'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

const ok: (req: MockRequest, emit: EmitFn) => Promise<void> = async (req, emit) => {
  await emit({
    type: InnerType.Resp,
    payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [] }))
  })
  await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode(req.path) })
  await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
}

async function setup() {
  const pairing: PairingInfo = {
    relayUrl: 'ws://relay.invalid',
    pairId: randomBytes(16),
    psk: await importPsk(randomBytes(32))
  }
  const sockets: MockAgentSocket[] = []
  const states: RelayState[] = []
  const transport = new RelayTransport(pairing, () => {
    const s = new MockAgentSocket(pairing.psk, pairing.pairId, ok)
    sockets.push(s)
    return s
  })
  transport.onStateChange((s) => states.push(s))
  return { transport, relayFetch: createRelayFetch(() => transport), sockets, states }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Waits for a full retire-then-rebuild cycle: the broken session is
 * dropped (`waiting`), then a fresh handshake installs a new one
 * (`online`). Watching for both halves matters — polling only for
 * `online` would return immediately, before the bad frame has even been
 * read. Bounded by real timer ticks, because the handshake in between is
 * genuine WebCrypto. */
async function waitForRecovery(transport: RelayTransport, states: RelayState[]): Promise<void> {
  for (let i = 0; i < 200 && !states.includes('waiting'); i++) await sleep(5)
  if (!states.includes('waiting')) throw new Error('the broken session was never retired')
  for (let i = 0; i < 200 && transport.getState() !== 'online'; i++) await sleep(5)
  if (transport.getState() !== 'online') {
    throw new Error(`transport never came back: stuck in ${transport.getState()}`)
  }
}

describe('relay session recovery', () => {
  it('re-handshakes in place instead of dropping the connection', async () => {
    const { transport, relayFetch, sockets, states } = await setup()

    expect(await (await relayFetch('/api/tags', { method: 'GET' })).text()).toBe('/api/tags')
    expect(sockets).toHaveLength(1)

    // The peer's keys and ours have diverged. Nothing here authenticates,
    // so nothing is acted on — the question is only what it costs.
    states.length = 0
    sockets[0].simulateUnopenableCiphertext()
    await waitForRecovery(transport, states)

    // It really did retire and rebuild a session, rather than never
    // noticing — but it never went offline, and never redialled.
    expect(states).toContain('waiting')
    expect(states).not.toContain('offline')
    expect(sockets).toHaveLength(1)

    // And the same socket serves requests again.
    expect(await (await relayFetch('/api/version', { method: 'GET' })).text()).toBe('/api/version')
    expect(sockets).toHaveLength(1)

    transport.close()
  })

  it('survives repeated session failures below the give-up threshold', async () => {
    const { transport, relayFetch, sockets, states } = await setup()
    await relayFetch('/api/tags', { method: 'GET' })

    for (let i = 0; i < 4; i++) {
      states.length = 0
      sockets[0].simulateUnopenableCiphertext()
      await waitForRecovery(transport, states)
      expect(await (await relayFetch(`/api/${i}`, { method: 'GET' })).text()).toBe(`/api/${i}`)
    }

    expect(sockets).toHaveLength(1)
    transport.close()
  })
})
