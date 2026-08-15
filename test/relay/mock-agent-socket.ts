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

  send(data: ArrayBufferLike | ArrayBufferView): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    void this.handleClientMessage(bytes)
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

  private async handleHandshakeFrame(payload: Uint8Array): Promise<void> {
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

    const myConfirm = await buildConfirm(session, Role.Agent)
    this.emitRaw(encodeOuter(Channel.Handshake, myConfirm))

    this.sealer = await Sealer.create(session.kA2W, session.npA2W)
    this.opener = await Opener.create(session.kW2A, session.npW2A)
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
        const emit: EmitFn = async (f) => {
          if (this.cancelledStreams.has(streamId) || !this.sealer) return
          const inner = encodeInner({ ...f, streamId })
          const headerBytes = new Uint8Array([Channel.Ciphertext, 0])
          const sealed = await this.sealer.seal(headerBytes, inner)
          this.emitRaw(encodeOuter(Channel.Ciphertext, sealed))
        }
        await this.handler({ method: buf.method, path: buf.path, headers: buf.headers, body }, emit)
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
