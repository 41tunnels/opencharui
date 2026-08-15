// A session's lifetime is not the connection's (spec §4.6): `peer_offline`
// ends a session, `peer_online` starts the next one, and both happen on
// the same socket. amallo has always worked this way; this client did not,
// and the gap was not cosmetic — an agent that redialled and displaced its
// own socket left this side `online`, sealing with keys nothing on the
// other end could open, and every message after that hung until the tab
// was reloaded.
//
// These run against MockAgentSocket, which performs the real handshake and
// real AEAD with only the network socket mocked. The cross-process version
// (real relay binary, two real agent processes) is in smoke.test.ts.
import { describe, expect, it } from 'vitest'
import { importPsk } from '@browser/relay/crypto'
import { createRelayFetch } from '@browser/relay/fetch'
import { RelayTransport, type PairingInfo, type RelayState } from '@browser/relay/transport'
import { InnerType } from '@browser/relay/wire'
import { MockAgentSocket, type EmitFn, type MockRequest } from './mock-agent-socket'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

async function makePairing(): Promise<PairingInfo> {
  return { relayUrl: 'ws://relay.invalid', pairId: randomBytes(16), psk: await importPsk(randomBytes(32)) }
}

/** Like fetch.test.ts's setup, but counts sockets and records every state
 * transition: the point of most of these tests is that recovery costs a
 * handshake, not a reconnect. */
async function setup(handler: (req: MockRequest, emit: EmitFn) => void | Promise<void>) {
  const pairing = await makePairing()
  const sockets: MockAgentSocket[] = []
  const states: RelayState[] = []
  const transport = new RelayTransport(pairing, (_url) => {
    const socket = new MockAgentSocket(pairing.psk, pairing.pairId, handler)
    sockets.push(socket)
    return socket
  })
  transport.onStateChange((s) => states.push(s))
  const relayFetch = createRelayFetch(() => transport)
  return { transport, relayFetch, sockets, states }
}

const okHandler = (body: string) => async (_req: MockRequest, emit: EmitFn) => {
  await emit({
    type: InnerType.Resp,
    payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [['content-type', 'application/json']] }))
  })
  await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode(body) })
  await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
}

/** Reads the body to completion, so no response frame is still in flight
 * when the test moves on — a stray frame from a retired session is fatal
 * by design (spec §4.6), which the last test here pins down. */
async function fetchFully(relayFetch: ReturnType<typeof createRelayFetch>, path: string): Promise<{ status: number; body: string }> {
  const res = await relayFetch(path, { method: 'GET' })
  return { status: res.status, body: await res.text() }
}

/** Waits for the *next* time the transport reaches `want`, ignoring the
 * state it is in right now — the transitions here are what matter, and a
 * check that passes because we were already online proves nothing. */
function waitForNextState(transport: RelayTransport, want: RelayState, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`timed out waiting for state ${want}, still ${transport.getState()}`))
    }, timeoutMs)
    const unsub = transport.onStateChange((s) => {
      if (s !== want) return
      clearTimeout(timer)
      unsub()
      resolve()
    })
  })
}

describe('session lifecycle within one connection', () => {
  it('re-handshakes on the same socket when the agent is displaced', async () => {
    const { transport, relayFetch, sockets } = await setup(okHandler('{"models":[]}'))
    expect((await fetchFully(relayFetch, '/api/tags')).status).toBe(200)

    // amallo redials and displaces its old socket: the relay swaps the
    // agent slot and tells this side nothing but `peer_online`.
    const backOnline = waitForNextState(transport, 'online')
    sockets[0].simulateAgentSwap()
    await backOnline

    // The regression this file exists for: before the fix this request
    // never arrived — sealed under the retired session's keys, held by the
    // agent as it waited for a HELLO that was never coming.
    const after = await fetchFully(relayFetch, '/api/tags')
    expect(after.status).toBe(200)
    expect(after.body).toBe('{"models":[]}')

    // One socket for the whole test: recovery is a handshake, not a
    // reconnect, so it costs a round trip rather than a backoff delay.
    expect(sockets).toHaveLength(1)
    transport.close()
  })

  it('fails a request that was in flight when the session was retired', async () => {
    // Never answers, so the request is still open when the swap lands.
    const { transport, relayFetch, sockets } = await setup(() => {})

    const inFlight = relayFetch('/api/tags', { method: 'GET' })
    await waitForNextState(transport, 'online')
    sockets[0].simulateAgentSwap()

    // The agent builds a fresh dispatcher per session, so this stream can
    // never be answered — failing it is what keeps the UI from spinning
    // forever on a reply that isn't coming.
    await expect(inFlight).rejects.toThrow(/offline/i)
    transport.close()
  })

  it('treats peer_offline as a steady state, not a connection failure', async () => {
    const { transport, relayFetch, sockets, states } = await setup(okHandler('{"models":[]}'))
    expect((await fetchFully(relayFetch, '/api/tags')).status).toBe(200)

    sockets[0].simulatePeerOffline()
    await waitForNextState(transport, 'waiting')

    const backOnline = waitForNextState(transport, 'online')
    sockets[0].simulateAgentSwap()
    await backOnline

    expect((await fetchFully(relayFetch, '/api/tags')).status).toBe(200)
    expect(sockets).toHaveLength(1)
    // Never went 'offline' — that state means the connection itself is
    // gone, which is not what losing a peer means.
    expect(states).not.toContain('offline')
    transport.close()
  })

  it('refuses to send while no session exists', async () => {
    const { transport, sockets } = await setup(okHandler('{}'))
    await waitForNextState(transport, 'online')

    sockets[0].simulatePeerOffline()
    await waitForNextState(transport, 'waiting')

    // Sealing under a retired session would consume a counter the peer's
    // opener is expecting for something else (spec §5).
    await expect(
      transport.send({ type: InnerType.Req, streamId: 99, payload: new Uint8Array() })
    ).rejects.toThrow(/not connected/)
    transport.close()
  })

  // Ciphertext that overtakes a new session — a peer still streaming a
  // response sealed under the one that just died — is held and then
  // dropped rather than taken as fatal. Staging that here would mean
  // driving the mock's internals frame by frame; smoke.test.ts's
  // cross-process case produces it from real timing instead.
})

describe('another client takes the pairing (spec §8, close 4409)', () => {
  it('stands down instead of taking it straight back', async () => {
    const pairing = await makePairing()
    const sockets: MockAgentSocket[] = []
    const states: RelayState[] = []
    const transport = new RelayTransport(pairing, () => {
      const socket = new MockAgentSocket(pairing.psk, pairing.pairId, okHandler('{}'))
      sockets.push(socket)
      return socket
    })
    transport.onStateChange((s) => states.push(s))
    await waitForNextState(transport, 'online')

    sockets[0].simulateDisplaced()
    await waitForNextState(transport, 'displaced')

    // The relay hands the pairing to one client at a time. Reconnecting
    // here would take it back from whoever just got it, and their client
    // would take it back from us — about once a second, forever, with
    // neither able to hold a session long enough to finish a reply.
    await new Promise((r) => setTimeout(r, 300))
    expect(sockets).toHaveLength(1)
    expect(transport.getState()).toBe('displaced')

    // And a request fails fast rather than waiting for a connection that
    // is never coming back on its own.
    const relayFetch = createRelayFetch(() => transport)
    await expect(relayFetch('/api/tags', { method: 'GET' })).rejects.toThrow(/another device or tab/)

    transport.close()
  })

  it('reclaims the pairing when the user asks for it', async () => {
    const pairing = await makePairing()
    const sockets: MockAgentSocket[] = []
    const transport = new RelayTransport(pairing, () => {
      const socket = new MockAgentSocket(pairing.psk, pairing.pairId, okHandler('{"models":[]}'))
      sockets.push(socket)
      return socket
    })
    await waitForNextState(transport, 'online')
    sockets[0].simulateDisplaced()
    await waitForNextState(transport, 'displaced')

    const backOnline = waitForNextState(transport, 'online')
    transport.reconnect()
    await backOnline

    const relayFetch = createRelayFetch(() => transport)
    expect((await fetchFully(relayFetch, '/api/tags')).status).toBe(200)
    expect(sockets).toHaveLength(2)

    transport.close()
  })
})
