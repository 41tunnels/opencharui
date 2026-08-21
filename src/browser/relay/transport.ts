// Manages one relay connection for the web client: dial, hello, the E2E
// handshake (spec §4), and a multiplexed inner-frame router keyed by
// stream_id. Reconnects automatically with exponential backoff and full
// jitter on any drop. Mirrors Amallo's `relay/conn.rs` — the same
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
import {
  Channel,
  InnerType,
  decodeInnerAll,
  encodeInner,
  encodeOuter,
  parseOuter,
  type InnerFrame
} from './wire'

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

export type RelayState = 'connecting' | 'waiting' | 'online' | 'offline' | 'displaced' | 'closed'

const WS_OPEN = 1

/** Spec §8: another connection for the same role took this slot. "do NOT
 * auto-reconnect, surface 'opened on another device'" — because the relay
 * keeps exactly one client per pair, and a displaced client that
 * reconnects immediately just displaces the other one straight back. Two
 * tabs then trade the slot about once a second and neither can hold a
 * session long enough to finish a reply. */
const CLOSE_DISPLACED = 4409

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
  if (typeof Blob !== 'undefined' && data instanceof Blob)
    return new Uint8Array(await data.arrayBuffer())
  throw new Error('relay: unexpected message data type')
}

/** A minimal async queue bridging the WebSocket's event-driven `message`/
 * `close`/`error` callbacks into a sequential `await queue.next()` loop —
 * the same shape as Amallo's `conn.rs` read loop, just expressed with
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
/** A connection that stayed up this long resets the backoff exponent —
 * mirrors Amallo's `BACKOFF_RESET_AFTER` (relay/mod.rs). Without it, the
 * only reset is a `connectOnce()` that returns without throwing, and a
 * browser socket dropping abnormally fires `error` before `close`, so the
 * common case never reset and every later reconnect inherited the delay
 * from some earlier flapping. */
const BACKOFF_RESET_AFTER_MS = 60_000

/** How long a single handshake may take before the connection is dropped
 * and retried. A peer that stops answering mid-handshake would otherwise
 * park this side forever on a socket the relay considers healthy — the
 * backstop for any race the session state machine below doesn't name. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** How many session failures one connection tolerates before it gives up
 * and reconnects. A session that cannot be opened is a problem with the
 * keys, not with the socket underneath — retiring the session and running
 * a fresh handshake fixes it in one round trip, where dropping the
 * connection costs a dial, a TLS handshake and a reconnect on the agent's
 * side too. Mirrors Amallo's `MAX_SESSION_FAILURES` (conn.rs); small,
 * because the legitimate cause (a peer that redialled mid-session) clears
 * on the first attempt. */
const MAX_SESSION_FAILURES = 5

/** Ciphertext frames held while a handshake finishes (spec §4.6). The peer
 * sends its first request the moment it has verified our CONFIRM, which
 * can be before we've installed the session — dropping those would strand
 * a request it considers sent, and §5's exact-counter rule leaves no
 * freedom about the order. Matches Amallo's `MAX_PENDING_CIPHERTEXT`. */
const MAX_PENDING_CIPHERTEXT = 16

/** Why a handshake attempt ended. `restart` means a newer peer attached
 * while we were still talking to the old one — the frames in flight belong
 * to a session that will never exist, so the only correct move is to begin
 * again rather than wait for a CONFIRM nobody will send. */
type HandshakeOutcome =
  | { kind: 'established'; sealer: Sealer; opener: Opener; pending: Uint8Array[] }
  | { kind: 'abandoned' }
  | { kind: 'restart' }

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
  /** Close code of the connection that just ended, so the reconnect loop
   * can tell "the network dropped" from "someone else took over". */
  private lastCloseCode: number | null = null
  /** Set once another client displaced this one; cleared by reconnect(). */
  private displaced = false
  /** Bumped whenever a session is retired, so a frame sealed under the
   * old one can be recognised (and dropped) before it reaches the wire. */
  private sessionEpoch = 0
  /** Consecutive session failures on the current connection — see
   * {@link MAX_SESSION_FAILURES}. Reset by any session that establishes. */
  private sessionFailures = 0
  /** Tail of the outbound chain — see {@link send}. Never rejects. */
  private sendChain: Promise<void> = Promise.resolve()

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
   * need to queue a request before the session exists.
   *
   * Every send is chained onto the previous one, because spec §5.1 is not
   * a suggestion: one direction has exactly one key and one counter, so
   * there must be exactly one sealing point driving them. `seal()` awaits
   * WebCrypto, and `fetch.ts` calls this from as many task chains as
   * there are in-flight requests — so without the chain, two sends that
   * overlap across that await both read the same counter before either
   * increments it. That reuses an AES-GCM nonce (which leaks the
   * authentication key and the XOR of the two plaintexts) and trips the
   * peer's exact-counter check, which drops the whole agent connection.
   * Amallo gets this structurally: its single writer task owns the
   * sealer, and nothing else can reach it. This is that writer task.
   *
   * The chain also fixes the second, quieter hazard: `ws.send` happens
   * *after* the await, so even correctly-numbered frames could reach the
   * wire out of counter order. Serialised sealing serialises both. */
  send(frame: InnerFrame): Promise<void> {
    // Settled either way, so one failed send never wedges the chain — but
    // the caller still sees its own rejection through `run`.
    const run = this.sendChain.then(() => this.sealAndSend(frame))
    this.sendChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async sealAndSend(frame: InnerFrame): Promise<void> {
    const sealer = this.sealer
    const epoch = this.sessionEpoch
    if (!this.ws || !sealer || this.state !== 'online') {
      throw new Error('relay: not connected')
    }
    const inner = encodeInner(frame)
    const header = new Uint8Array([Channel.Ciphertext, 0])
    const sealed = await sealer.seal(header, inner)
    // Sealing is async, and a session can be retired across that await —
    // most visibly while a long request body is still streaming out. A
    // frame from the previous session must never reach the wire after
    // that: the peer would hold it against the new session's counter
    // sequence (§5's exact-counter rule) and drop the connection over a
    // frame that was never meant for it.
    if (this.sessionEpoch !== epoch) {
      throw new Error('relay: session ended before the frame was sent')
    }
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
    // Waiting would never resolve: nothing reconnects until the user
    // reclaims the pairing.
    if (this.displaced) {
      throw new Error('relay: this pairing is in use on another device or tab')
    }
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
        } else if (s === 'displaced') {
          cleanup()
          reject(new Error('relay: this pairing is in use on another device or tab'))
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Reclaims a pairing that another client took over. Only meaningful
   * after a `displaced` close, which is the one case where this side stops
   * reconnecting on its own. */
  reconnect(): void {
    if (this.closing || !this.displaced) return
    this.displaced = false
    this.lastCloseCode = null
    this.backoffMs = BACKOFF_BASE_MS
    void this.runLoop()
  }

  isDisplaced(): boolean {
    return this.displaced
  }

  close(): void {
    this.closing = true
    this.setState('closed')
    this.ws?.close()
  }

  private async runLoop(): Promise<void> {
    while (!this.closing) {
      this.setState('connecting')
      const attemptStart = Date.now()
      this.lastCloseCode = null
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

      // Another client took the pairing. Retrying would take it back from
      // them, and their client would take it back from us, forever — so
      // stand down and let the user decide which one wins (`reconnect()`).
      if (this.lastCloseCode === CLOSE_DISPLACED) {
        this.displaced = true
        this.setState('displaced')
        for (const cb of [...this.peerOfflineListeners]) cb()
        return
      }

      this.setState('offline')
      // A connection that ran fine for a while and then dropped is not
      // evidence the relay (or network) is in trouble, however it ended.
      if (Date.now() - attemptStart > BACKOFF_RESET_AFTER_MS) this.backoffMs = BACKOFF_BASE_MS
      const delay = this.backoffMs * Math.random()
      await sleep(delay)
      this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CAP_MS)
    }
  }

  /**
   * Runs one connection to completion. A *session* — the E2E handshake and
   * the keys it produces — lives and dies inside this, possibly several
   * times over (spec §4.6: "the next `peer_online` starts a fresh
   * handshake on the same socket"). That is what Amallo has always done on
   * its side; without the matching behaviour here, an agent that redialled
   * and displaced its old socket left this client attached, `online`, and
   * sealing with keys nothing on the other end could open.
   */
  private async connectOnce(): Promise<void> {
    const url = this.pairing.relayUrl.replace(/\/+$/, '') + '/v1/client'
    const ws = this.socketFactory(url)
    this.ws = ws
    this.sessionFailures = 0

    const queue = new AsyncQueue<Uint8Array>()
    const onMessage = (ev: Event) => {
      void toUint8Array((ev as MessageEvent).data).then(
        (bytes) => queue.push(bytes),
        (err) => queue.end(err)
      )
    }
    const onClose = (ev: Event) => {
      this.lastCloseCode = (ev as CloseEvent).code ?? null
      queue.end()
    }
    const onError = () => queue.end(new Error('relay: socket error'))
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)

    try {
      await waitForOpen(ws)
      await this.sendHello(ws)
      await this.expectControl(queue, 'hello_ok')

      // Attached but unpaired. An ordinary steady state now, not a
      // transient one on the way to the handshake.
      this.setState('waiting')

      // Main read loop: route by channel, carrying the session lifecycle
      // underneath. The sequential-await shape is what preserves the
      // backpressure and ordering guarantees the protocol depends on.
      while (true) {
        const { value: raw, done } = await queue.next()
        if (done) return
        const { header, payload } = parseOuter(raw)

        if (header.channel === Channel.Control) {
          const t = controlType(payload)
          if (t === 'peer_online') {
            await this.startSession(ws, queue)
          } else if (t === 'peer_offline') {
            this.retireSession()
          } else if (t === 'error') {
            // `agent_offline` on attach means there is nothing to pair
            // with and the relay closes right after — fail the connection
            // so the reconnect loop backs off. An error arriving on a
            // connection that already had a session (e.g. `peer_offline`
            // racing a frame we'd already sealed) only retires the
            // session; the socket itself is still fine.
            if (!this.sealer) throw new Error(`relay: error: ${controlCode(payload)}`)
            this.retireSession()
          }
          // going_away: the relay closes right after, and a close is
          // handled the same as any other drop (reconnect).
          continue
        }

        if (header.channel === Channel.Handshake) {
          // A peer HELLO that overtook (or replaced) the `peer_online`
          // that should have preceded it. Without this, a re-pair whose
          // notification was lost would strand the connection with no way
          // back — the same guard Amallo's read loop carries.
          await this.startSession(ws, queue, payload)
          continue
        }

        if (header.channel === Channel.Ciphertext) {
          // A session-level failure is scoped to the session. Whatever
          // went wrong is in the keys, and the socket underneath is
          // healthy — so retire the session and offer a fresh handshake
          // rather than hanging up. The peer picks that up automatically
          // (spec §4.6), and it costs one round trip instead of a
          // reconnect on both sides. Only a connection that cannot get a
          // working session at all falls through to a real reconnect.
          let failure: string | null = null
          if (!this.opener) {
            // No session, and none in progress: nothing here can be
            // authenticated, so nothing is acted on. But a peer sending
            // ciphertext believes a session exists, and the useful reply
            // to that is a handshake, not a closed socket.
            failure = 'ciphertext frame arrived with no established session'
          } else {
            try {
              await this.handleCiphertext(payload)
            } catch (err) {
              failure = err instanceof Error ? err.message : String(err)
            }
          }

          if (failure !== null) {
            this.sessionFailures += 1
            if (this.sessionFailures >= MAX_SESSION_FAILURES) {
              throw new Error(
                `relay: giving up after ${this.sessionFailures} session failures: ${failure}`
              )
            }
            await this.startSession(ws, queue)
          }
          continue
        }
      }
    } finally {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }
  }

  /** Retires the current session's keys and fails anything waiting on it.
   * In-flight streams belong to a peer that is gone — Amallo builds a
   * fresh dispatcher per session, so they can never be answered. */
  private retireSession(): void {
    const hadSession = this.sealer !== null
    this.sessionEpoch++
    this.sealer = null
    this.opener = null
    this.listeners.clear()
    if (!this.closing) this.setState('waiting')
    if (!hadSession) return
    // Copied: `fetch.ts`'s handler unsubscribes itself as it runs.
    for (const cb of [...this.peerOfflineListeners]) cb()
  }

  /** Runs a handshake to completion and installs the session it produces.
   * `initialFrame` is a peer HELLO already read off the wire. */
  private async startSession(
    ws: WebSocketLike,
    queue: AsyncQueue<Uint8Array>,
    initialFrame?: Uint8Array
  ): Promise<void> {
    this.retireSession()

    let firstFrame = initialFrame
    for (;;) {
      const timer = setTimeout(() => ws.close(), HANDSHAKE_TIMEOUT_MS)
      let outcome: HandshakeOutcome
      try {
        outcome = await this.handshake(ws, queue, firstFrame)
      } finally {
        clearTimeout(timer)
      }

      if (outcome.kind === 'abandoned') return
      if (outcome.kind === 'restart') {
        // The HELLO that triggered the restart was consumed as the signal,
        // not as a frame — the new peer sends its own once we send ours.
        firstFrame = undefined
        continue
      }

      this.sealer = outcome.sealer
      this.opener = outcome.opener
      this.sessionFailures = 0
      this.setState('online')
      // Anything the peer sent between verifying our CONFIRM and now,
      // opened in arrival order — the AEAD counter allows no other.
      for (const payload of outcome.pending) {
        try {
          await this.handleCiphertext(payload)
        } catch {
          // Unlike a frame that arrives *after* the session is installed,
          // one held from before it is not necessarily meant for it: a
          // peer that was mid-response when a redial displaced the
          // previous connection sealed these under the session that just
          // died. They fail to authenticate, so nothing is acted on —
          // dropping beats killing a healthy connection over a frame the
          // peer has already given up on. Amallo does the same (conn.rs).
        }
      }
      return
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

  private async handshake(
    ws: WebSocketLike,
    queue: AsyncQueue<Uint8Array>,
    initialFrame?: Uint8Array
  ): Promise<HandshakeOutcome> {
    const pending: Uint8Array[] = []
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

    const helloStep = initialFrame ?? (await this.readHandshakeFrame(queue, pending))
    if (typeof helloStep === 'string') return { kind: helloStep }
    const peerHelloRaw = helloStep
    await verifyHello(this.pairing.psk, peerHelloRaw, this.pairing.pairId, Role.Client)

    // agent's HELLO always precedes web's in the transcript (spec §4.4),
    // regardless of which side observed which HELLO first.
    const t = await computeTranscript(peerHelloRaw, myHello)
    const peerEpk = extractEpk(peerHelloRaw)
    const ecdhX = await computeEcdh(eph.privateKey, peerEpk)
    const session = await deriveSession(this.pairing.psk, t, ecdhX)

    const myConfirm = await buildConfirm(session, Role.Client)
    ws.send(encodeOuter(Channel.Handshake, myConfirm))

    const confirmStep = await this.readHandshakeFrame(queue, pending)
    if (typeof confirmStep === 'string') return { kind: confirmStep }
    await verifyConfirm(session, confirmStep, Role.Agent)

    // Direction naming is from the wire spec's perspective (a2w = agent
    // to web): web seals with the w2a key and opens with the a2w key.
    return {
      kind: 'established',
      sealer: await Sealer.create(session.kW2A, session.npW2A),
      opener: await Opener.create(session.kA2W, session.npA2W),
      pending
    }
  }

  /** Next channel-0x02 payload, or why the handshake can't continue.
   * Ciphertext arriving here is held rather than dropped (spec §4.6). */
  private async readHandshakeFrame(
    queue: AsyncQueue<Uint8Array>,
    pending: Uint8Array[]
  ): Promise<Uint8Array | 'abandoned' | 'restart'> {
    for (;;) {
      const { value: raw, done } = await queue.next()
      if (done) throw new Error('relay: connection closed during handshake')
      const { header, payload } = parseOuter(raw)

      if (header.channel === Channel.Handshake) return payload

      if (header.channel === Channel.Ciphertext) {
        if (pending.length >= MAX_PENDING_CIPHERTEXT) {
          throw new Error(
            'relay: too many ciphertext frames arrived before the session was established'
          )
        }
        pending.push(payload)
        continue
      }

      if (header.channel === Channel.Control) {
        const t = controlType(payload)
        // The peer we were handshaking with is gone; a later peer_online
        // starts the next one.
        if (t === 'peer_offline') return 'abandoned'
        // A newer peer attached mid-handshake (an agent redial displacing
        // the one whose CONFIRM we were waiting for). Its HELLO is coming,
        // not the old peer's.
        if (t === 'peer_online') return 'restart'
        if (t === 'error') throw new Error(`relay: error during handshake: ${controlCode(payload)}`)
        continue
      }
    }
  }

  private async handleCiphertext(payload: Uint8Array): Promise<void> {
    if (!this.opener) return
    const headerBytes = new Uint8Array([Channel.Ciphertext, 0])
    const plaintext = await this.opener.open(headerBytes, payload)
    const frames = decodeInnerAll(plaintext)
    for (const frame of frames) {
      this.listeners.get(frame.streamId)?.(frame)
    }
  }
}

function parseControl(payload: Uint8Array): { t?: string; code?: string } {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as { t?: string; code?: string }
  } catch {
    return {}
  }
}

function controlType(payload: Uint8Array): string | undefined {
  return parseControl(payload).t
}

function controlCode(payload: Uint8Array): string {
  return parseControl(payload).code ?? 'unknown'
}

// Re-exported so fetch.ts (and tests) can construct CANCEL/ERROR frames
// without a second import of wire.ts's InnerType for that one use.
export { InnerType }
export { HandshakeError }
