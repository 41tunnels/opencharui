// OpenCharUI relay E2E handshake and AEAD session (spec/PROTOCOL.md §4-§6),
// implemented over the Web Crypto API. Mirrors the Go reference
// implementation in `relay/internal/proto` and the Rust port in
// `amallo/src-tauri/src/relay/crypto.rs` (once that lands in Step 5) —
// all three are checked against the same shared vectors (test/vectors/,
// test/relay/crypto.test.ts). The relay itself never calls this module —
// channel 0x01/0x02 payloads are opaque to it.
//
// Curve: P-256, not X25519 — WebCrypto X25519 support only landed in
// Chrome 133/Firefox 132/Safari 17.4, too new for a phone-first client;
// P-256 `deriveBits` has been universal for years. Cipher: AES-256-GCM,
// the only fast AEAD WebCrypto exposes.

const ENC = new TextEncoder()

// --- shared helpers ----------------------------------------------------

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Constant-time comparison — every MAC/tag check in this module goes
 * through this, never `===`/`Array.every` on secret-derived bytes. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** TypeScript 5.7+ types `Uint8Array` as generic over its backing buffer
 * (`Uint8Array<ArrayBufferLike>`), but WebCrypto's `BufferSource` requires
 * an `ArrayBuffer` specifically — `ArrayBufferLike` also covers
 * `SharedArrayBuffer`, which the DOM lib's crypto types deliberately
 * exclude. Every `Uint8Array` in this module is always backed by a plain
 * `ArrayBuffer` (nothing here ever touches a SharedArrayBuffer), so this
 * narrows the type to satisfy the DOM lib without copying. */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as Uint8Array<ArrayBuffer>
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// --- error type ----------------------------------------------------------

export type HandshakeErrorCode =
  | 'bad_length'
  | 'bad_mac'
  | 'pair_mismatch'
  | 'role_reflection'
  | 'bad_version'
  | 'bad_point'
  | 'confirm_mismatch'
  | 'confirm_role'
  | 'counter_mismatch'
  | 'counter_exhausted'
  | 'auth_failed'

/** Thrown by every function in this module; `.code` is the stable string
 * the shared vectors' `expect_error` field uses, matching the Go
 * implementation's `proto.ErrorCode` mapping 1:1 — needed because Go
 * error identity and JS exception identity aren't comparable across
 * languages, but a plain string is. */
export class HandshakeError extends Error {
  readonly code: HandshakeErrorCode
  constructor(code: HandshakeErrorCode) {
    super(code)
    this.name = 'HandshakeError'
    this.code = code
  }
}

// --- roles -----------------------------------------------------------------

export const Role = { Agent: 0x01, Client: 0x02 } as const
export type RoleValue = (typeof Role)[keyof typeof Role]

const PROTO_VERSION = 0x01
const PAIR_ID_LEN = 16
const PSK_LEN = 32
const EPK_LEN = 65 // uncompressed SEC1 P-256 point: 0x04 || X(32) || Y(32)
const NONCE_LEN = 32
const MAC_LEN = 32
const TAG_LEN = 32
const HELLO_LEN = 1 + 1 + PAIR_ID_LEN + EPK_LEN + NONCE_LEN + MAC_LEN // 147
const CONFIRM_LEN = 1 + 1 + TAG_LEN // 34

// --- HKDF (RFC 5869) via WebCrypto's combined extract+expand -------------
//
// WebCrypto's HKDF `deriveBits` performs the full two-step RFC 5869
// process (Extract then Expand) in one call and does not expose an
// intermediate PRK. That's fine: HKDF-Extract(salt, ikm) is a pure,
// deterministic function of its inputs, so calling `deriveBits` again with
// the *same* (salt, ikm) but a *different* info string recomputes the
// identical PRK internally before expanding — mathematically identical to
// the Go implementation's separate Extract-once/Expand-many-times calls.

async function importHkdfKey(ikm: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(ikm), 'HKDF', false, ['deriveBits'])
}

async function hkdfDeriveBytes(
  ikmKey: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBufferSource(salt), info: asBufferSource(info) },
    ikmKey,
    lengthBytes * 8
  )
  return new Uint8Array(bits)
}

/** Imports raw PSK bytes as a non-extractable HKDF key — the canonical
 * (and only) way pairing material becomes the `CryptoKey` every
 * handshake function below expects. Every PSK-consuming function in this
 * module takes a `CryptoKey`, never raw bytes, specifically so a caller
 * can import once here, persist the result via IndexedDB's structured
 * clone (see `db/relay-secrets.ts`), and never hold the raw bytes again —
 * a non-extractable key that's later re-derived-from-bytes on every use
 * would defeat the whole point. */
export async function importPsk(pskBytes: Uint8Array): Promise<CryptoKey> {
  if (pskBytes.length !== PSK_LEN) throw new HandshakeError('bad_length')
  return importHkdfKey(pskBytes)
}

/** Derives the HELLO-MAC key from the PSK (spec §4.3). Exported (like the
 * Go `KMac`/`PSKIKM`) purely so cross-implementation debugging and vector
 * generation can inspect intermediate values — normal handshake code
 * never calls this directly except via buildHello/verifyHello. */
export async function kMac(psk: CryptoKey): Promise<Uint8Array> {
  return hkdfDeriveBytes(psk, new Uint8Array(0), ENC.encode('opencharui/v1 hello-mac'), 32)
}

export async function pskIkm(psk: CryptoKey, transcript: Uint8Array): Promise<Uint8Array> {
  const info = concatBytes(ENC.encode('opencharui/v1 psk-ikm'), transcript)
  return hkdfDeriveBytes(psk, new Uint8Array(0), info, 32)
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', hmacKey, asBufferSource(data))
  return new Uint8Array(sig)
}

// --- ephemeral P-256 keys ---------------------------------------------------

export interface Ephemeral {
  privateKey: CryptoKey
  publicKeyBytes: Uint8Array // uncompressed SEC1, 65 bytes
}

/** Generates a fresh, random ephemeral key pair — used for exactly one
 * handshake and never persisted or reused across reconnects (spec §4.2). */
export async function generateEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const pub = await crypto.subtle.exportKey('raw', pair.publicKey)
  return { privateKey: pair.privateKey, publicKeyBytes: new Uint8Array(pub) }
}

/** Constructs a deterministic key pair from a raw 32-byte scalar and its
 * corresponding public key bytes. Exists solely so test vectors can make
 * the handshake a pure function — WebCrypto cannot import a raw P-256
 * private scalar directly (only 'jwk' or 'pkcs8'), so this builds the JWK
 * form from the scalar (`d`) plus the public point's X/Y, which the
 * vectors already carry. Every implementation of this spec exposes an
 * equivalent seam; see the Go `EphemeralFromScalar` and its doc comment. */
export async function ephemeralFromScalarAndPublicKey(
  scalar: Uint8Array,
  publicKeyBytes: Uint8Array
): Promise<Ephemeral> {
  if (publicKeyBytes.length !== EPK_LEN) throw new HandshakeError('bad_length')
  const x = publicKeyBytes.slice(1, 33)
  const y = publicKeyBytes.slice(33, 65)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: base64UrlEncode(scalar),
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
    ext: true
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )
  return { privateKey, publicKeyBytes }
}

/** Performs the key agreement against a peer's HELLO-carried public key
 * and returns the shared X-coordinate (spec §4.4's `ecdh_x`). `peerEpk`
 * is the raw 65-byte uncompressed point from the peer's HELLO;
 * `HandshakeError('bad_point')` if it is not a valid point on P-256 —
 * WebCrypto's `importKey` validates this as part of import, which is also
 * where invalid-curve attacks are rejected. */
export async function ecdh(myPrivateKey: CryptoKey, peerEpk: Uint8Array): Promise<Uint8Array> {
  let peerPublicKey: CryptoKey
  try {
    peerPublicKey = await crypto.subtle.importKey(
      'raw',
      asBufferSource(peerEpk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )
  } catch {
    throw new HandshakeError('bad_point')
  }
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, myPrivateKey, 256)
  return new Uint8Array(bits)
}

// --- HELLO -------------------------------------------------------------------

export interface HelloFields {
  ver: number
  role: number
  pairId: Uint8Array
  epk: Uint8Array
  nonce: Uint8Array
  mac: Uint8Array
  raw: Uint8Array
}

/** Encodes and MACs a HELLO message (spec §4.3). `nonce` must be exactly
 * 32 bytes — callers pass a fresh random nonce in production and a
 * vector-fixed nonce when validating against test vectors. */
export async function buildHello(
  psk: CryptoKey,
  role: number,
  pairId: Uint8Array,
  epk: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  if (pairId.length !== PAIR_ID_LEN) throw new HandshakeError('bad_length')
  if (epk.length !== EPK_LEN) throw new HandshakeError('bad_length')
  if (nonce.length !== NONCE_LEN) throw new HandshakeError('bad_length')

  const body = concatBytes(new Uint8Array([PROTO_VERSION, role]), pairId, epk, nonce)
  const kmac = await kMac(psk)
  const mac = await hmacSha256(kmac, concatBytes(ENC.encode('opencharui/v1 hello'), body))
  return concatBytes(body, mac)
}

/** Splits a raw HELLO without verifying it — use {@link verifyHello} for
 * the authenticated path. Exposed separately so negative test vectors can
 * observe "parses fine, fails verification" distinctly. */
export function parseHello(raw: Uint8Array): HelloFields {
  if (raw.length !== HELLO_LEN) throw new HandshakeError('bad_length')
  let off = 0
  const ver = raw[off]
  off += 1
  const role = raw[off]
  off += 1
  const pairId = raw.slice(off, off + PAIR_ID_LEN)
  off += PAIR_ID_LEN
  const epk = raw.slice(off, off + EPK_LEN)
  off += EPK_LEN
  const nonce = raw.slice(off, off + NONCE_LEN)
  off += NONCE_LEN
  const mac = raw.slice(off, off + MAC_LEN)
  return { ver, role, pairId, epk, nonce, mac, raw }
}

/** Parses and applies every check from spec §4.3, in the same order as
 * the Go reference implementation (version, pair_id, role, MAC, point) —
 * negative test vectors encode whichever error that specific ordering
 * produces first, so this order is load-bearing for vector agreement, not
 * arbitrary. `ownRole` is the verifier's own role: a peer's HELLO must
 * always carry the *other* role, or it's a reflection of our own. */
export async function verifyHello(
  psk: CryptoKey,
  raw: Uint8Array,
  expectPairId: Uint8Array,
  ownRole: number
): Promise<HelloFields> {
  const f = parseHello(raw)
  if (f.ver !== PROTO_VERSION) throw new HandshakeError('bad_version')
  if (!constantTimeEqual(f.pairId, expectPairId)) throw new HandshakeError('pair_mismatch')
  if (f.role === ownRole) throw new HandshakeError('role_reflection')

  const kmac = await kMac(psk)
  const macInput = concatBytes(ENC.encode('opencharui/v1 hello'), raw.slice(0, HELLO_LEN - MAC_LEN))
  const expected = await hmacSha256(kmac, macInput)
  if (!constantTimeEqual(expected, f.mac)) throw new HandshakeError('bad_mac')

  // Point validity — reject before it's used in ECDH.
  try {
    await crypto.subtle.importKey(
      'raw',
      asBufferSource(f.epk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )
  } catch {
    throw new HandshakeError('bad_point')
  }

  return f
}

// --- transcript and session key derivation ---------------------------------

/** Computes spec §4.4's canonical, role-ordered transcript hash.
 * `helloAgent`/`helloWeb` are the exact 147-byte HELLO wire encodings —
 * agent's HELLO always precedes web's in the hash input, regardless of
 * which one either side observed first. */
export async function transcript(helloAgent: Uint8Array, helloWeb: Uint8Array): Promise<Uint8Array> {
  const input = concatBytes(ENC.encode('opencharui/v1 transcript'), helloAgent, helloWeb)
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(input))
  return new Uint8Array(digest)
}

export interface SessionKeys {
  /** Not the raw HKDF PRK — see the WebCrypto note above: this is the
   * imported (salt=transcript, ikm=ecdhX‖pskIkm) HKDF key, re-used for
   * every subsequent Expand-equivalent call in this session, including
   * the CONFIRM tags. */
  ikmKey: CryptoKey
  transcript: Uint8Array
  kA2W: Uint8Array
  kW2A: Uint8Array
  npA2W: Uint8Array
  npW2A: Uint8Array
}

/** Computes the session keys from the PSK, the transcript, and the raw
 * ECDH shared secret (spec §4.4). `pskIkm` folded into the extraction is
 * what blocks relay MITM: a relay without the PSK — even one that swapped
 * both ephemeral public keys in transit — cannot derive anything past
 * this point. */
export async function deriveSession(
  psk: CryptoKey,
  transcriptBytes: Uint8Array,
  ecdhX: Uint8Array
): Promise<SessionKeys> {
  const pskIkmBytes = await pskIkm(psk, transcriptBytes)
  const ikm = concatBytes(ecdhX, pskIkmBytes)
  const ikmKey = await importHkdfKey(ikm)

  const [kA2W, kW2A, npA2W, npW2A] = await Promise.all([
    hkdfDeriveBytes(ikmKey, transcriptBytes, ENC.encode('opencharui/v1 key-a2w'), 32),
    hkdfDeriveBytes(ikmKey, transcriptBytes, ENC.encode('opencharui/v1 key-w2a'), 32),
    hkdfDeriveBytes(ikmKey, transcriptBytes, ENC.encode('opencharui/v1 np-a2w'), 4),
    hkdfDeriveBytes(ikmKey, transcriptBytes, ENC.encode('opencharui/v1 np-w2a'), 4)
  ])

  return { ikmKey, transcript: transcriptBytes, kA2W, kW2A, npA2W, npW2A }
}

// --- CONFIRM -----------------------------------------------------------------

async function confirmTag(session: SessionKeys, role: number): Promise<Uint8Array> {
  const label = role === Role.Agent ? 'opencharui/v1 confirm-agent' : 'opencharui/v1 confirm-web'
  return hkdfDeriveBytes(session.ikmKey, session.transcript, ENC.encode(label), TAG_LEN)
}

/** Encodes this side's CONFIRM (spec §4.5). `role` is the sender's own
 * role. */
export async function buildConfirm(session: SessionKeys, role: number): Promise<Uint8Array> {
  const tag = await confirmTag(session, role)
  return concatBytes(new Uint8Array([PROTO_VERSION, role]), tag)
}

/** Checks a peer's CONFIRM. `expectRole` is the *peer's* expected role
 * (the role opposite the verifier). No channel-0x01 frame may be sent or
 * accepted before this succeeds (spec §4.5) — enforced by callers, not by
 * this function. */
export async function verifyConfirm(session: SessionKeys, raw: Uint8Array, expectRole: number): Promise<void> {
  if (raw.length !== CONFIRM_LEN) throw new HandshakeError('bad_length')
  if (raw[0] !== PROTO_VERSION) throw new HandshakeError('bad_version')
  const role = raw[1]
  if (role !== expectRole) throw new HandshakeError('confirm_role')
  const expected = await confirmTag(session, role)
  if (!constantTimeEqual(expected, raw.slice(2, 2 + TAG_LEN))) {
    throw new HandshakeError('confirm_mismatch')
  }
}

// --- AEAD session (spec §5) --------------------------------------------------

const NONCE_PREFIX_LEN = 4
const NONCE_COUNTER_LEN = 8
const GCM_TAG_LEN = 16

/** Encrypts one direction of a session. Owns the counter exclusively.
 *
 * spec §5.1 is not a suggestion: exactly one Sealer must exist per
 * direction, and its {@link seal} must not be called concurrently (e.g.
 * from two in-flight requests at once without external serialization).
 * Concurrent unsynchronized use produces two frames encrypted under the
 * same nonce, which breaks AES-GCM catastrophically (authentication key
 * recovery, plaintext XOR disclosure). This class has no internal locking
 * by design — it pushes callers toward a single owning task/queue rather
 * than a mutex that invites sharing the Sealer "for convenience". */
export class Sealer {
  private key: CryptoKey
  private prefix: Uint8Array
  private counter = 0n
  private closed = false

  private constructor(key: CryptoKey, prefix: Uint8Array) {
    this.key = key
    this.prefix = prefix
  }

  static async create(rawKey: Uint8Array, prefix: Uint8Array): Promise<Sealer> {
    if (rawKey.length !== 32) throw new HandshakeError('bad_length')
    if (prefix.length !== NONCE_PREFIX_LEN) throw new HandshakeError('bad_length')
    const key = await crypto.subtle.importKey('raw', asBufferSource(rawKey), { name: 'AES-GCM' }, false, [
      'encrypt'
    ])
    return new Sealer(key, prefix)
  }

  /** Test/vector-generation only: starts the counter at `start` rather
   * than 0. Normal sessions always start at 0 and never resume a counter
   * across a reconnect (spec §5.1) — this exists only so vectors can be
   * checked at specific counter values without a production API exposing
   * a "set counter" foot-gun. */
  static async createAt(rawKey: Uint8Array, prefix: Uint8Array, start: bigint): Promise<Sealer> {
    const s = await Sealer.create(rawKey, prefix)
    s.counter = start
    return s
  }

  /** Encrypts `plaintext` for the given outer-frame header bytes
   * (spec §5: AAD = outer_header_bytes ‖ counter) and returns the full
   * channel-0x01 payload: `[counter:8][ciphertext‖tag]`. */
  async seal(headerBytes: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new HandshakeError('counter_exhausted')
    const counter = this.counter
    if (counter === 0xffffffffffffffffn) {
      this.closed = true
      throw new HandshakeError('counter_exhausted')
    }
    // Claimed before the await, not after. A caller is required to
    // serialise its sends (spec §5.1 — see RelayTransport.send), but this
    // counter is the thing whose reuse is catastrophic, so it does not
    // rely on being asked nicely: incrementing after `encrypt` resolved
    // would hand the same counter to any second call that started while
    // the first was suspended, and two frames under one AES-GCM nonce
    // leak the authentication key and the XOR of both plaintexts. A
    // counter burned by a failed encrypt leaves a gap, which the peer
    // rejects — failing closed, which is the safe side of this trade.
    this.counter = counter + 1n
    const nonce = makeNonce(this.prefix, counter)
    const aad = makeAad(headerBytes, counter)
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(aad),
        tagLength: GCM_TAG_LEN * 8
      },
      this.key,
      asBufferSource(plaintext)
    )
    return concatBytes(counterBytes(counter), new Uint8Array(ciphertext))
  }
}

/** Decrypts and authenticates one direction of a session. Rejects any
 * payload whose counter is not exactly the next expected value — no
 * window, no reordering (spec §5). */
export class Opener {
  private key: CryptoKey
  private prefix: Uint8Array
  private expected = 0n
  private closed = false

  private constructor(key: CryptoKey, prefix: Uint8Array) {
    this.key = key
    this.prefix = prefix
  }

  static async create(rawKey: Uint8Array, prefix: Uint8Array): Promise<Opener> {
    if (rawKey.length !== 32) throw new HandshakeError('bad_length')
    if (prefix.length !== NONCE_PREFIX_LEN) throw new HandshakeError('bad_length')
    const key = await crypto.subtle.importKey('raw', asBufferSource(rawKey), { name: 'AES-GCM' }, false, [
      'decrypt'
    ])
    return new Opener(key, prefix)
  }

  /** Test-only: see {@link Sealer.createAt}. */
  static async createAt(rawKey: Uint8Array, prefix: Uint8Array, start: bigint): Promise<Opener> {
    const o = await Opener.create(rawKey, prefix)
    o.expected = start
    return o
  }

  async open(headerBytes: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new HandshakeError('counter_exhausted')
    if (payload.length < NONCE_COUNTER_LEN + GCM_TAG_LEN) throw new HandshakeError('bad_length')

    const counter = bytesCounter(payload.slice(0, NONCE_COUNTER_LEN))
    if (counter !== this.expected) throw new HandshakeError('counter_mismatch')

    const sealed = payload.slice(NONCE_COUNTER_LEN)
    const nonce = makeNonce(this.prefix, counter)
    const aad = makeAad(headerBytes, counter)

    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(aad),
          tagLength: GCM_TAG_LEN * 8
        },
        this.key,
        asBufferSource(sealed)
      )
    } catch {
      throw new HandshakeError('auth_failed')
    }

    if (this.expected === 0xffffffffffffffffn) {
      this.closed = true
    } else {
      this.expected += 1n
    }
    return new Uint8Array(plaintext)
  }
}

function counterBytes(counter: bigint): Uint8Array {
  const out = new Uint8Array(NONCE_COUNTER_LEN)
  let v = counter
  for (let i = NONCE_COUNTER_LEN - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function bytesCounter(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

function makeNonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  return concatBytes(prefix, counterBytes(counter))
}

/** Builds `[outer_header_bytes][counter:8]` per spec §5. `headerBytes`
 * must be the exact outer-frame header bytes that accompanied this
 * payload on the wire (see `OuterHeader.headerBytes` in wire.ts). */
function makeAad(headerBytes: Uint8Array, counter: bigint): Uint8Array {
  return concatBytes(headerBytes, counterBytes(counter))
}
