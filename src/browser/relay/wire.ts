// OpenCharUI relay wire format: the outer frame (relay-visible) and the
// inner frame (carried inside decrypted channel-0x01 payloads). Mirrors
// the Go reference implementation in `relay/internal/wire` and the Rust
// port in `amallo/src-tauri/src/relay/wire.rs` byte for byte — all three
// are checked against the same shared vectors (see test/vectors/ and
// test/relay/wire.test.ts). See the relay repo's spec/PROTOCOL.md (§2, §6)
// for the normative description.

/** Outer-frame channel byte (spec §2). Plain numbers, not a TS enum —
 * `const enum` is incompatible with this project's `isolatedModules`
 * setting, and a value here that doesn't match one of these three is not
 * itself invalid (the relay forwards anything that isn't the control
 * channel as opaque data), so a closed type would be the wrong model
 * anyway. */
export const Channel = {
  Control: 0x00,
  Ciphertext: 0x01,
  Handshake: 0x02
} as const

const FLAG_CONN_ID = 0x01
/** Every reserved bit (1-7): MUST be zero in v1 (spec §2). */
const FLAGS_RESERVED_MASK = 0xfe

export type WireErrorCode =
  | 'frame_too_short'
  | 'reserved_flags_set'
  | 'conn_id_not_v1'
  | 'inner_frame_too_short'
  | 'inner_payload_too_long'
  | 'inner_truncated'
  | 'inner_reserved_type'

/** Thrown by every function in this module. `code` is the stable string
 * the shared test vectors' `expect_error` field uses — the same rationale
 * as the Go and Rust implementations' equivalents: a plain string is what
 * all three languages can compare, exception-type identity is not. */
export class WireError extends Error {
  readonly code: WireErrorCode
  constructor(code: WireErrorCode) {
    super(code)
    this.name = 'WireError'
    this.code = code
  }
}

/** Parsed `[channel][flags]` outer-frame header, exactly as transmitted.
 * `headerBytes` is what goes into the AEAD associated data once relay
 * crypto lands here — kept as the literal wire bytes, not a
 * re-serialization, so a serialization bug elsewhere can never silently
 * change what was authenticated. */
export interface OuterHeader {
  channel: number
  flags: number
  headerBytes: Uint8Array
}

export interface ParsedOuter {
  header: OuterHeader
  payload: Uint8Array
}

/** Splits a raw WebSocket binary message into its header and payload.
 * Validates the reserved-bits rule (spec §2) but does not interpret the
 * payload — that is the caller's job, based on `header.channel`. */
export function parseOuter(msg: Uint8Array): ParsedOuter {
  if (msg.length < 2) throw new WireError('frame_too_short')
  const flags = msg[1]
  if ((flags & FLAGS_RESERVED_MASK) !== 0) throw new WireError('reserved_flags_set')
  if ((flags & FLAG_CONN_ID) !== 0) {
    // Defined by the spec's wire format but not a valid v1 message.
    throw new WireError('conn_id_not_v1')
  }
  return {
    header: { channel: msg[0], flags, headerBytes: msg.slice(0, 2) },
    payload: msg.slice(2)
  }
}

/** Builds a v1 outer frame (no `conn_id` — that field does not exist yet). */
export function encodeOuter(channel: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length)
  out[0] = channel
  out[1] = 0
  out.set(payload, 2)
  return out
}

// --- Inner frames (spec §6) -------------------------------------------------

export const InnerType = {
  Req: 0x01,
  ReqBody: 0x02,
  ReqEnd: 0x03,
  Resp: 0x04,
  RespBody: 0x05,
  RespEnd: 0x06,
  Cancel: 0x07,
  Error: 0x08,
  // Reserved — MUST NOT be sent in v1 (spec §6, §9).
  WindowUpdate: 0x09,
  Ping: 0x0a,
  Pong: 0x0b
} as const

const RESERVED_INNER_TYPES: ReadonlySet<number> = new Set([
  InnerType.WindowUpdate,
  InnerType.Ping,
  InnerType.Pong
])

/** Largest payload representable in the 3-byte length field (spec §6):
 * 2^24 - 1. */
export const MAX_INNER_PAYLOAD = (1 << 24) - 1

const INNER_HEADER_LEN = 1 + 4 + 3 // type + stream_id + len

export interface InnerFrame {
  type: number
  streamId: number
  payload: Uint8Array
}

/** Encodes one inner frame. Frames are meant to be concatenated for the
 * batching path (spec §6) — use {@link encodeInnerAll} for that; this is
 * the single-frame building block it's built from. */
export function encodeInner(frame: InnerFrame): Uint8Array {
  if (frame.payload.length > MAX_INNER_PAYLOAD) throw new WireError('inner_payload_too_long')
  if (RESERVED_INNER_TYPES.has(frame.type)) throw new WireError('inner_reserved_type')

  const out = new Uint8Array(INNER_HEADER_LEN + frame.payload.length)
  out[0] = frame.type
  out[1] = (frame.streamId >>> 24) & 0xff
  out[2] = (frame.streamId >>> 16) & 0xff
  out[3] = (frame.streamId >>> 8) & 0xff
  out[4] = frame.streamId & 0xff
  const len = frame.payload.length
  out[5] = (len >>> 16) & 0xff
  out[6] = (len >>> 8) & 0xff
  out[7] = len & 0xff
  out.set(frame.payload, INNER_HEADER_LEN)
  return out
}

/** Encodes multiple inner frames concatenated into one payload — the
 * opportunistic-batching shape a single decrypted ciphertext payload may
 * carry (spec §6). */
export function encodeInnerAll(frames: readonly InnerFrame[]): Uint8Array {
  const parts = frames.map(encodeInner)
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Parses every inner frame concatenated in `buf` — a single decrypted
 * ciphertext payload may carry more than one inner frame (spec §6
 * batching), so callers must always decode a payload as a sequence, never
 * assume exactly one frame per payload. */
export function decodeInnerAll(buf: Uint8Array): InnerFrame[] {
  const frames: InnerFrame[] = []
  let offset = 0
  while (offset < buf.length) {
    if (buf.length - offset < INNER_HEADER_LEN) throw new WireError('inner_frame_too_short')

    const type = buf[offset]
    const streamId =
      ((buf[offset + 1] << 24) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 8) |
        buf[offset + 4]) >>>
      0
    const length = (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7]

    const bodyStart = offset + INNER_HEADER_LEN
    if (buf.length - bodyStart < length) throw new WireError('inner_truncated')
    if (RESERVED_INNER_TYPES.has(type)) throw new WireError('inner_reserved_type')

    frames.push({ type, streamId, payload: buf.slice(bodyStart, bodyStart + length) })
    offset = bodyStart + length
  }
  return frames
}

/** Reports whether `streamId` was allocated by the web client (odd, per
 * spec §6). Agent-initiated (even) streams are reserved for a future
 * push-style extension and unused in v1. */
export function isClientInitiated(streamId: number): boolean {
  return streamId % 2 === 1
}
