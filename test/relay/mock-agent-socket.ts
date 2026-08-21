// A WebSocketLike that plays the *agent* role for real — using this
// project's own crypto.ts to perform the actual E2E handshake and AEAD
// sealing/opening — so tests exercise RelayTransport and relayFetch
// end-to-end (real handshake, real encryption) with only the network
// socket itself mocked out. Not a `.test.ts` file: vitest.config.ts only
// picks up `test/**/*.test.ts`, so this helper is never run as a suite.
import {
  Opener,
  Role,
  Sealer,
  buildConfirm,
  buildHello,
  deriveSession,
  ecdh as computeEcdh,
  generateEphemeral,
  transcript as computeTranscript,
  verifyConfirm,
  verifyHello
} from '@browser/relay/crypto'
import {
  Channel,
  InnerType,
  decodeInnerAll,
  encodeInner,
  encodeOuter,
  parseOuter,
  type InnerFrame
} from '@browser/relay/wire'
import type { WebSocketLike } from '@browser/relay/transport'

export interface MockRequest {
  method: string
  path: string
  headers: [string, string][]
  body: Uint8Array
}

export type EmitFn = (frame: Omit<InnerFrame, 'streamId'>) => Promise<void>
export type ReqHandler = (req: MockRequest, emit: EmitFn) => void | Promise<void>

function extractEpk(hello: Uint8Array): Uint8Array {
  const off = 1 + 1 + 16
  return hello.slice(off, off + 65)
}

const WS_OPEN = 1
const WS_CLOSED = 3
/** Spec §4.3's fixed HELLO length. A handshake frame of exactly this size
 * is a HELLO; anything else in a handshake is a CONFIRM. */
const HELLO_LEN = 147

type SocketListener = (ev: MessageEvent | Event) => void

export class MockAgentSocket implements WebSocketLike {
  readyState = 0
  private listeners = new Map<string, Set<SocketListener>>()
  private psk: CryptoKey
  private pairId: Uint8Array
  private handler: ReqHandler
  private closed = false

  private agentEph: Awaited<ReturnType<typeof generateEphemeral>> | null = null
  private myHello: Uint8Array | null = null
  private clientHello: Uint8Array | null = null
  private sealer: Sealer | null = null
  private opener: Opener | null = null

  /** Tail of the inbound chain — see {@link send}. */
  private inbound: Promise<void> = Promise.resolve()
  /** Tail of the outbound chain — see {@link seal}. */
  private outbound: Promise<void> = Promise.resolve()

  private reqBuffers = new Map<number, { method: string; path: string; headers: [string, string][]; chunks: Uint8Array[] }>()
  private cancelledStreams = new Set<number>()

  constructor(psk: CryptoKey, pairId: Uint8Array, handler: ReqHandler) {
    this.psk = psk
    this.pairId = pairId
    this.handler = handler
    queueMicrotask(() => {
      this.readyState = WS_OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  addEventListener(type: string, listener: SocketListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private dispatch(type: string, ev: MessageEvent | Event): void {
    for (const l of this.listeners.get(type) ?? []) l(ev)
  }

  private emitRaw(bytes: Uint8Array): void {
    if (this.closed) return
    queueMicrotask(() => this.dispatch('message', { data: bytes } as MessageEvent))
  }

  private emitControl(obj: unknown): void {
    this.emitRaw(encodeOuter(Channel.Control, new TextEncoder().encode(JSON.stringify(obj))))
  }

  close(): void {
    this.closed = true
    this.readyState = WS_CLOSED
    queueMicrotask(() => this.dispatch('close', new Event('close')))
  }

  /** Test control: the relay closing this client because another one took
   * the pairing (spec §8, close code 4409). */
  simulateDisplaced(): void {
    this.closed = true
    this.readyState = WS_CLOSED
    // Node has no CloseEvent, and the transport only reads `.code`.
    const event = Object.assign(new Event('close'), { code: 4409, reason: 'displaced' })
    queueMicrotask(() => this.dispatch('close', event))
  }

  /** Decrypting and routing is strictly one frame at a time, chained
   * here. `Opener.open` checks the expected counter, awaits WebCrypto,
   * then advances it — so opening two frames concurrently makes the
   * second read a counter the first has not incremented yet and reject a
   * perfectly good frame as `counter_mismatch`. The real agent cannot hit
   * this (conn.rs has one read loop that awaits each frame before reading
   * the next), and this mock stands in for the real agent, so it has the
   * same property — including the part where the read loop only ever
   * *dispatches* a request and never waits for the response (see
   * {@link handleInner}), so a slow handler cannot delay the CANCEL that
   * is meant to stop it. */
  send(data: ArrayBufferLike | ArrayBufferView): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    this.inbound = this.inbound.then(
      () => this.handleClientMessage(bytes),
      () => this.handleClientMessage(bytes)
    )
  }

  /** Test control: simulate the relay reporting the agent went offline. */
  simulatePeerOffline(): void {
    this.emitControl({ t: 'peer_offline' })
  }

  /** Test control: simulate amallo redialling and *displacing* its own
   * previous socket — what happens on sleep/wake or a Wi-Fi flip, when it
   * reconnects before the relay's ping/pong noticed the old socket was
   * dead. The relay swaps the agent slot underneath and sends the client a
   * bare `peer_online`: no `peer_offline`, no close. This side keeps the
   * socket and starts a completely new session on it (spec §4.6), so every
   * key from the previous one is gone.
   *
   * Ciphertext arriving in the window before the new session is installed
   * is dropped here rather than held; the real agent buffers it, and no
   * test below sends into that window. */
  simulateAgentSwap(): void {
    this.agentEph = null
    this.myHello = null
    this.clientHello = null
    this.sealer = null
    this.opener = null
    this.reqBuffers.clear()
    this.cancelledStreams.clear()
    this.emitControl({ t: 'peer_online' })
  }

  private async handleClientMessage(bytes: Uint8Array): Promise<void> {
    const { header, payload } = parseOuter(bytes)

    if (header.channel === Channel.Control) {
      const msg = JSON.parse(new TextDecoder().decode(payload)) as { t: string }
      if (msg.t === 'hello') {
        this.emitControl({ t: 'hello_ok', conn: '1', ping_ms: 30000 })
        this.emitControl({ t: 'peer_online' })
      }
      return
    }

    if (header.channel === Channel.Handshake) {
      await this.handleHandshakeFrame(payload)
      return
    }

    if (header.channel === Channel.Ciphertext && this.opener) {
      const headerBytes = new Uint8Array([Channel.Ciphertext, 0])
      const plaintext = await this.opener.open(headerBytes, payload)
      for (const frame of decodeInnerAll(plaintext)) await this.handleInner(frame)
    }
  }

  /** Test control: emit a channel-0x01 frame this session cannot open —
   * what the client sees when the peer's keys and its own have diverged
   * (a redial the notification for got lost, a counter gap). */
  simulateUnopenableCiphertext(): void {
    const garbage = crypto.getRandomValues(new Uint8Array(8 + 16 + 4))
    this.emitRaw(encodeOuter(Channel.Ciphertext, garbage))
  }

  private async handleHandshakeFrame(payload: Uint8Array): Promise<void> {
    // A HELLO always starts a fresh handshake, whatever state this side
    // was in. That is what lets a peer recover a broken session in place
    // (spec §4.6) instead of dropping the connection, and the real agent
    // behaves the same way — its read loop starts a new handshake on a
    // bare 0x02 rather than interpreting it against the old session.
    if (payload.length === HELLO_LEN && this.agentEph) {
      this.agentEph = null
      this.myHello = null
      this.clientHello = null
      this.sealer = null
      this.opener = null
      this.reqBuffers.clear()
      this.cancelledStreams.clear()
    }

    if (!this.agentEph) {
      // First frame from the client: their HELLO.
      this.agentEph = await generateEphemeral()
      const nonce = crypto.getRandomValues(new Uint8Array(32))
      this.myHello = await buildHello(this.psk, Role.Agent, this.pairId, this.agentEph.publicKeyBytes, nonce)
      await verifyHello(this.psk, payload, this.pairId, Role.Agent)
      this.clientHello = payload
      this.emitRaw(encodeOuter(Channel.Handshake, this.myHello))
      return
    }

    // Second frame: the client's CONFIRM.
    const t = await computeTranscript(this.myHello!, this.clientHello!)
    const ecdhX = await computeEcdh(this.agentEph.privateKey, extractEpk(this.clientHello!))
    const session = await deriveSession(this.psk, t, ecdhX)
    await verifyConfirm(session, payload, Role.Client)

    // Installed before the CONFIRM goes out, not after: the client is free
    // to send ciphertext the instant it verifies our CONFIRM, and on a
    // loaded runner these WebCrypto imports are slow enough for that
    // ciphertext to arrive here first. Emitting after leaves a window where
    // it's read against no opener (silently dropped) or, worse, against
    // whatever opener a *later* handshake on this same reused socket has
    // just installed (a stray counter from the wrong session).
    const sealer = await Sealer.create(session.kA2W, session.npA2W)
    const opener = await Opener.create(session.kW2A, session.npW2A)
    this.sealer = sealer
    this.opener = opener

    const myConfirm = await buildConfirm(session, Role.Agent)
    this.emitRaw(encodeOuter(Channel.Handshake, myConfirm))
  }

  /** The agent side's single sealing point (spec §5.1). Concurrent
   * request handlers all emit through here, and one direction has one
   * counter, so the seals have to be serialised the way the real agent's
   * single writer task serialises them. */
  private seal(streamId: number, f: Omit<InnerFrame, 'streamId'>): Promise<void> {
    const run = this.outbound.then(async () => {
      if (this.cancelledStreams.has(streamId) || !this.sealer) return
      const inner = encodeInner({ ...f, streamId })
      const headerBytes = new Uint8Array([Channel.Ciphertext, 0])
      const sealed = await this.sealer.seal(headerBytes, inner)
      this.emitRaw(encodeOuter(Channel.Ciphertext, sealed))
    })
    this.outbound = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async handleInner(frame: InnerFrame): Promise<void> {
    switch (frame.type) {
      case InnerType.Req: {
        const head = JSON.parse(new TextDecoder().decode(frame.payload)) as {
          m: string
          p: string
          h: [string, string][]
        }
        this.reqBuffers.set(frame.streamId, { method: head.m, path: head.p, headers: head.h, chunks: [] })
        break
      }
      case InnerType.ReqBody:
        this.reqBuffers.get(frame.streamId)?.chunks.push(frame.payload)
        break
      case InnerType.ReqEnd: {
        const buf = this.reqBuffers.get(frame.streamId)
        if (!buf) return
        const total = buf.chunks.reduce((s, c) => s + c.length, 0)
        const body = new Uint8Array(total)
        let off = 0
        for (const c of buf.chunks) {
          body.set(c, off)
          off += c.length
        }
        const streamId = frame.streamId
        const emit: EmitFn = (f) => this.seal(streamId, f)
        // Detached, exactly as the real agent spawns a task per request
        // rather than blocking its read loop on one — see the note on
        // `send`. Awaiting here would hold every later frame (a CANCEL,
        // or another stream's REQ) behind this response.
        void Promise.resolve(
          this.handler({ method: buf.method, path: buf.path, headers: buf.headers, body }, emit)
        ).catch(() => undefined)
        break
      }
      case InnerType.Cancel:
        this.cancelledStreams.add(frame.streamId)
        this.reqBuffers.delete(frame.streamId)
        break
      default:
        break
    }
  }
}
