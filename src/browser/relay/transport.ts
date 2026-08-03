// Manages one relay connection for the web client: dial, hello, the E2E
// handshake (spec §4), and a multiplexed inner-frame router keyed by
// stream_id. Reconnects automatically with exponential backoff and full
// jitter on any drop. Mirrors amallo's `relay/conn.rs` — the same
// protocol, the client side of it.
import {
  HandshakeError,
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
} from './crypto'
import { Channel, InnerType, decodeInnerAll, encodeInner, encodeOuter, parseOuter, type InnerFrame } from './wire'

export interface WebSocketLike {
  readonly readyState: number
  send(data: ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: MessageEvent | Event) => void): void
  removeEventListener(type: string, listener: (ev: MessageEvent | Event) => void): void
}

export type SocketFactory = (url: string) => WebSocketLike

export interface PairingInfo {
  relayUrl: string
  pairId: Uint8Array // 16 bytes
  /** An already-imported, non-extractable HKDF key (see
   * `crypto.ts`'s `importPsk`) — never raw bytes. This is what makes the
   * non-extractable-CryptoKey storage design (`db/relay-secrets.ts`)
   * actually hold end to end: once a PSK is imported, the raw bytes never
   * need to exist in JS memory again for any handshake to work. */
  psk: CryptoKey
}

export type RelayState = 'connecting' | 'waiting' | 'online' | 'offline' | 'closed'

const WS_OPEN = 1

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extracts the 65-byte public key straight out of a raw HELLO wire
 * encoding (spec §4.3's fixed layout: ver‖role‖pair_id‖epk‖nonce‖mac) —
 * avoids a second parse of fields we already know the offsets of. */
function extractEpk(hello: Uint8Array): Uint8Array {
  const off = 1 + 1 + 16 // ver + role + pair_id
  return hello.slice(off, off + 65)
}

function waitForOpen(ws: WebSocketLike): Promise<void> {
  if (ws.readyState === WS_OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('relay: socket failed to open'))
    }
    const cleanup = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  throw new Error('relay: unexpected message data type')
}

/** A minimal async queue bridging the WebSocket's event-driven `message`/
 * `close`/`error` callbacks into a sequential `await queue.next()` loop —
 * the same shape as amallo's `conn.rs` read loop, just expressed with
 * promises instead of a blocking channel receive. */
class AsyncQueue<T> {
  private items: T[] = []
  private resolvers: ((r: IteratorResult<T>) => void)[] = []
  private ended = false
  private error: unknown

  push(item: T): void {
    const r = this.resolvers.shift()
    if (r) r({ value: item, done: false })
    else this.items.push(item)
  }

  end(err?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.error = err
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as never, done: true })
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return { value: this.items.shift() as T, done: false }
    if (this.ended) {
      if (this.error) throw this.error
      return { value: undefined as never, done: true }
    }
    return new Promise((resolve) => this.resolvers.push(resolve))
  }
}

export type FrameListener = (frame: InnerFrame) => void

const BACKOFF_BASE_MS = 500
const BACKOFF_MULTIPLIER = 1.8
const BACKOFF_CAP_MS = 30_000

export class RelayTransport {
  private pairing: PairingInfo
  private socketFactory: SocketFactory
  private ws: WebSocketLike | null = null
  private sealer: Sealer | null = null
  private opener: Opener | null = null
  private nextStreamId = 1
  private listeners = new Map<number, FrameListener>()
  private peerOfflineListeners = new Set<() => void>()
  private state: RelayState = 'connecting'
  private stateListeners = new Set<(s: RelayState) => void>()
  private closing = false
  private backoffMs = BACKOFF_BASE_MS

  constructor(pairing: PairingInfo, socketFactory: SocketFactory = defaultSocketFactory) {
    this.pairing = pairing
    this.socketFactory = socketFactory
    void this.runLoop()
  }

  getState(): RelayState {
    return this.state
  }

  onStateChange(cb: (s: RelayState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  /** Fires whenever the relay reports the agent has disconnected — any
   * request awaiting a response at that moment will never get one over
   * this session, so `fetch.ts` uses this to reject pending promises
   * instead of hanging until a full reconnect. */
  onPeerOffline(cb: () => void): () => void {
    this.peerOfflineListeners.add(cb)
    return () => this.peerOfflineListeners.delete(cb)
  }

  private setState(s: RelayState): void {
    this.state = s
    for (const cb of this.stateListeners) cb(s)
  }

  /** Allocates a fresh client-initiated (odd) stream id (spec §6). */
  allocateStreamId(): number {
    const id = this.nextStreamId
    this.nextStreamId += 2
    return id
  }

  /** Registers a listener for inner frames on `streamId`. Returns an
   * unsubscribe function — callers must unsubscribe once a stream
   * completes (RESP_END/ERROR/CANCEL) or the map leaks. */
  onFrame(streamId: number, listener: FrameListener): () => void {
    this.listeners.set(streamId, listener)
    return () => this.listeners.delete(streamId)
  }

  /** Encrypts and sends one inner frame. Throws if not currently online —
   * callers are expected to await {@link waitUntilOnline} first if they
   * need to queue a request before the session exists. */
  async send(frame: InnerFrame): Promise<void> {
    if (!this.ws || !this.sealer || this.state !== 'online') {
      throw new Error('relay: not connected')
    }
    const inner = encodeInner(frame)
    const header = new Uint8Array([Channel.Ciphertext, 0])
    const sealed = await this.sealer.seal(header, inner)
    this.ws.send(encodeOuter(Channel.Ciphertext, sealed))
  }

  /** Resolves once the transport reaches `online` (peer attached, E2E
   * session established), or rejects if closed first or `signal` fires
   * first — without a signal this can hang indefinitely while stuck in
   * `connecting`/`waiting`/`offline` (e.g. the relay or agent is simply
   * unreachable), which is exactly the case callers need to bound with a
   * timeout. */
  async waitUntilOnline(signal?: AbortSignal): Promise<void> {
    if (this.state === 'online') return
    if (this.state === 'closed') throw new Error('relay: transport closed')
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        unsub()
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      const unsub = this.onStateChange((s) => {
        if (s === 'online') {
          cleanup()
          resolve()
        } else if (s === 'closed') {
          cleanup()
          reject(new Error('relay: transport closed'))
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  close(): void {
    this.closing = true
    this.setState('closed')
    this.ws?.close()
  }

  private async runLoop(): Promise<void> {
    while (!this.closing) {
      this.setState('connecting')
      try {
        await this.connectOnce()
        this.backoffMs = BACKOFF_BASE_MS
      } catch {
        // fall through to backoff/reconnect below
      }
      this.ws = null
      this.sealer = null
      this.opener = null
      this.listeners.clear()
      if (this.closing) return
      this.setState('offline')
      const delay = this.backoffMs * Math.random()
      await sleep(delay)
      this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CAP_MS)
    }
  }

  private async connectOnce(): Promise<void> {
    const url = this.pairing.relayUrl.replace(/\/+$/, '') + '/v1/client'
    const ws = this.socketFactory(url)
    this.ws = ws

    const queue = new AsyncQueue<Uint8Array>()
    const onMessage = (ev: Event) => {
      void toUint8Array((ev as MessageEvent).data).then(
        (bytes) => queue.push(bytes),
        (err) => queue.end(err)
      )
    }
    const onClose = () => queue.end()
    const onError = () => queue.end(new Error('relay: socket error'))
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)

    try {
      await waitForOpen(ws)
      await this.sendHello(ws)
      await this.expectControl(queue, 'hello_ok')
      await this.expectControl(queue, 'peer_online')
      await this.handshake(ws, queue)

      this.setState('online')

      // Main read loop: decrypt, decode, and route inner frames — the
      // sequential-await shape here is exactly what preserves the
      // backpressure and ordering guarantees the protocol depends on.
      while (true) {
        const { value: raw, done } = await queue.next()
        if (done) return
        await this.handleIncoming(raw)
      }
    } finally {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }
  }

  private sendHello(ws: WebSocketLike): void {
    const hello = {
      t: 'hello',
      v: 1,
      role: 'client',
      pair: base64UrlEncode(this.pairing.pairId),
      token: ''
    }
    const bytes = new TextEncoder().encode(JSON.stringify(hello))
    ws.send(encodeOuter(Channel.Control, bytes))
  }

  private async expectControl(queue: AsyncQueue<Uint8Array>, wantType: string): Promise<void> {
    const { value: raw, done } = await queue.next()
    if (done) throw new Error(`relay: connection closed before ${wantType}`)
    const { header, payload } = parseOuter(raw)
    if (header.channel !== Channel.Control) {
      throw new Error(`relay: expected control channel for ${wantType}`)
    }
    const msg = JSON.parse(new TextDecoder().decode(payload)) as { t: string; code?: string }
    if (msg.t === 'error') throw new Error(`relay: error before ${wantType}: ${msg.code}`)
    if (msg.t !== wantType) throw new Error(`relay: expected control ${wantType}, got ${msg.t}`)
  }

  private async handshake(ws: WebSocketLike, queue: AsyncQueue<Uint8Array>): Promise<void> {
    const eph = await generateEphemeral()
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const myHello = await buildHello(
      this.pairing.psk,
      Role.Client,
      this.pairing.pairId,
      eph.publicKeyBytes,
      nonce
    )
    ws.send(encodeOuter(Channel.Handshake, myHello))

    const peerHelloRaw = await this.readHandshakeFrame(queue)
    await verifyHello(this.pairing.psk, peerHelloRaw, this.pairing.pairId, Role.Client)

    // agent's HELLO always precedes web's in the transcript (spec §4.4),
    // regardless of which side observed which HELLO first.
    const t = await computeTranscript(peerHelloRaw, myHello)
    const peerEpk = extractEpk(peerHelloRaw)
    const ecdhX = await computeEcdh(eph.privateKey, peerEpk)
    const session = await deriveSession(this.pairing.psk, t, ecdhX)

    const myConfirm = await buildConfirm(session, Role.Client)
    ws.send(encodeOuter(Channel.Handshake, myConfirm))

    const peerConfirmRaw = await this.readHandshakeFrame(queue)
    await verifyConfirm(session, peerConfirmRaw, Role.Agent)

    // Direction naming is from the wire spec's perspective (a2w = agent
    // to web): web seals with the w2a key and opens with the a2w key.
    this.sealer = await Sealer.create(session.kW2A, session.npW2A)
    this.opener = await Opener.create(session.kA2W, session.npA2W)
  }

  private async readHandshakeFrame(queue: AsyncQueue<Uint8Array>): Promise<Uint8Array> {
    const { value: raw, done } = await queue.next()
    if (done) throw new Error('relay: connection closed during handshake')
    const { header, payload } = parseOuter(raw)
    if (header.channel !== Channel.Handshake) throw new Error('relay: expected handshake channel')
    return payload
  }

  private async handleIncoming(raw: Uint8Array): Promise<void> {
    const { header, payload } = parseOuter(raw)
    if (header.channel === Channel.Control) {
      this.handleControl(payload)
      return
    }
    if (header.channel !== Channel.Ciphertext || !this.opener) return
    const headerBytes = new Uint8Array([Channel.Ciphertext, 0])
    const plaintext = await this.opener.open(headerBytes, payload)
    const frames = decodeInnerAll(plaintext)
    for (const frame of frames) {
      this.listeners.get(frame.streamId)?.(frame)
    }
  }

  private handleControl(payload: Uint8Array): void {
    let msg: { t?: string }
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: string }
    } catch {
      return
    }
    if (msg.t === 'peer_offline') {
      this.setState('waiting')
      for (const cb of this.peerOfflineListeners) cb()
    }
    // going_away/peer_online/error: no action needed beyond what the
    // connection lifecycle (runLoop/connectOnce) already does — a
    // going_away close is handled the same as any other drop (reconnect),
    // and peer_online is implicit in reaching the 'online' state.
  }
}

// Re-exported so fetch.ts (and tests) can construct CANCEL/ERROR frames
// without a second import of wire.ts's InnerType for that one use.
export { InnerType }
export { HandshakeError }
