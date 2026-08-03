// End-to-end tests of RelayTransport + relayFetch against MockAgentSocket
// — a WebSocketLike that performs the *real* E2E handshake and AEAD
// sealing/opening (via this project's own crypto.ts, playing the agent
// role), so only the network socket itself is mocked. This is the
// "vitest covers streaming, getReader() chunking, abort→CANCEL,
// peer_offline rejection" verification layer from the build plan's Step 9.
import { describe, expect, it } from 'vitest'
import { importPsk } from '@browser/relay/crypto'
import { createRelayFetch } from '@browser/relay/fetch'
import { RelayTransport, type PairingInfo } from '@browser/relay/transport'
import { InnerType } from '@browser/relay/wire'
import { MockAgentSocket, type EmitFn, type MockRequest } from './mock-agent-socket'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

async function makePairing(): Promise<PairingInfo> {
  return { relayUrl: 'ws://relay.invalid', pairId: randomBytes(16), psk: await importPsk(randomBytes(32)) }
}

async function setup(handler: (req: MockRequest, emit: EmitFn) => void | Promise<void>) {
  const pairing = await makePairing()
  let socket: MockAgentSocket
  const transport = new RelayTransport(pairing, (_url) => {
    socket = new MockAgentSocket(pairing.psk, pairing.pairId, handler)
    return socket
  })
  const relayFetch = createRelayFetch(() => transport)
  return { transport, relayFetch, getSocket: () => socket }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

describe('relayFetch: basic request/response', () => {
  it('performs a simple GET and reads the body', async () => {
    const { relayFetch } = await setup(async (req, emit) => {
      expect(req.method).toBe('GET')
      expect(req.path).toBe('/api/tags')
      await emit({ type: InnerType.Resp, payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [['content-type', 'application/json']] })) })
      await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode('{"models":[]}') })
      await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
    })

    const res = await relayFetch('/api/tags', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = await readAll(res.body!)
    expect(new TextDecoder().decode(body)).toBe('{"models":[]}')
  })

  it('sends a request body via REQ_BODY frames', async () => {
    const { relayFetch } = await setup(async (req, emit) => {
      expect(new TextDecoder().decode(req.body)).toBe('{"hello":"world"}')
      await emit({ type: InnerType.Resp, payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [] })) })
      await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
    })

    const res = await relayFetch('/api/chat', { method: 'POST', body: '{"hello":"world"}' })
    expect(res.status).toBe(200)
  })
})

describe('relayFetch: streaming', () => {
  it('delivers multiple RESP_BODY frames as separate reads, not buffered into one', async () => {
    const { relayFetch } = await setup(async (_req, emit) => {
      await emit({ type: InnerType.Resp, payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [] })) })
      await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode('{"a":1}\n') })
      await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode('{"b":2}\n') })
      await emit({ type: InnerType.RespEnd, payload: new Uint8Array() })
    })

    const res = await relayFetch('/api/chat', { method: 'POST' })
    const reader = res.body!.getReader()
    const chunk1 = await reader.read()
    expect(new TextDecoder().decode(chunk1.value)).toBe('{"a":1}\n')
    const chunk2 = await reader.read()
    expect(new TextDecoder().decode(chunk2.value)).toBe('{"b":2}\n')
    const done = await reader.read()
    expect(done.done).toBe(true)
  })
})

describe('relayFetch: abort/cancel', () => {
  it('aborting before headers arrive rejects the relayFetch() promise itself', async () => {
    const { relayFetch } = await setup(async () => {
      // Never respond — the abort must be what settles this, not a RESP.
    })
    const controller = new AbortController()
    const resPromise = relayFetch('/api/tags', { method: 'GET', signal: controller.signal })
    controller.abort()
    await expect(resPromise).rejects.toThrow(/aborted/i)
  })

  it('aborting mid-stream (after headers) errors the body stream and drops the late frame', async () => {
    // Real fetch() semantics: once headers arrive, the Response promise is
    // already resolved — aborting after that errors the *body stream*,
    // it can't retroactively reject an already-settled promise.
    let handlerFinished = false
    const { relayFetch } = await setup(async (_req, emit) => {
      await emit({
        type: InnerType.Resp,
        payload: new TextEncoder().encode(JSON.stringify({ s: 200, h: [] }))
      })
      // Simulate a slow upstream: this chunk is emitted only after the
      // client's CANCEL should already have arrived. MockAgentSocket
      // drops sends for a cancelled stream_id, so if CANCEL propagated
      // correctly, this chunk never reaches relayFetch's body stream.
      await new Promise((r) => setTimeout(r, 20))
      await emit({ type: InnerType.RespBody, payload: new TextEncoder().encode('should not arrive') })
      handlerFinished = true
    })

    const controller = new AbortController()
    const res = await relayFetch('/api/chat', { method: 'POST', signal: controller.signal })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const readPromise = reader.read()
    controller.abort()

    await expect(readPromise).rejects.toThrow(/aborted/i)
    await new Promise((r) => setTimeout(r, 30))
    expect(handlerFinished).toBe(true) // the handler ran to completion server-side...
    // ...but its late frame never reached us, because CANCEL reached the
    // mock agent before that emit() call and it silently dropped it.
  })
})

describe('relayFetch: timeout while the transport never comes online', () => {
  it('a timeout signal aborts relayFetch even while stuck waiting for the transport to connect', async () => {
    // Regression test: waitUntilOnline() previously ignored the caller's
    // signal entirely, so a request issued while the relay/agent is
    // unreachable would hang forever regardless of any AbortSignal.timeout
    // passed in — this is exactly the path ollama.ts's fetchTags() relies
    // on to bound startup probing. Here the mock socket never calls
    // dispatch('open', ...) is irrelevant; what matters is the transport
    // simply never reaches 'online', simulated by a socket factory that
    // returns a socket stuck in the CONNECTING readyState forever.
    const pairing: PairingInfo = { relayUrl: 'ws://relay.invalid', pairId: randomBytes(16), psk: await importPsk(randomBytes(32)) }
    const stuckSocket = {
      readyState: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
      send: () => {}
    }
    const transport = new RelayTransport(pairing, () => stuckSocket)
    const relayFetch = createRelayFetch(() => transport)

    const start = Date.now()
    await expect(
      relayFetch('/api/tags', { method: 'GET', signal: AbortSignal.timeout(50) })
    ).rejects.toThrow(/aborted/i)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('relayFetch: peer offline', () => {
  it('rejects a pending request when the transport reports peer_offline', async () => {
    const { relayFetch, getSocket } = await setup(async () => {
      // Deliberately never respond — the request should be rejected by
      // the peer_offline signal, not by ever getting a RESP.
    })

    const resPromise = relayFetch('/api/tags', { method: 'GET' })
    // Give the handshake a tick to complete before firing peer_offline.
    await new Promise((r) => setTimeout(r, 10))
    getSocket().simulatePeerOffline()

    await expect(resPromise).rejects.toThrow(/offline/)
  })
})
