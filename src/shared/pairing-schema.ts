import { z } from 'zod'

const PAIR_ID_BYTES = 16
const PSK_BYTES = 32

export interface PairingInput {
  version: number
  relayUrl: string
  pairId: Uint8Array
  psk: Uint8Array
}

export function base64UrlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new Error('not valid base64url')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const rawSchema = z.string().trim().min(1, 'pairing code must not be empty')

/**
 * Parses the `opencharui://pair?v=1&r=<relay_url>&i=<pair_id>&k=<psk>` URI
 * amallo's QR code encodes (spec §4.2) — replaces the old copy-JSON
 * connection blob (`connection-schema.ts`, deleted) now that pairing is a
 * single scan or paste rather than a manually-copied `{url, api_key}`
 * object. Accepts either the full `opencharui://...` URI (from a scan) or
 * just the query-string-bearing tail — the QR and the "copy pairing code"
 * fallback both encode the same string, so this doesn't need to care
 * which path produced it.
 */
export const parsePairingCode = (raw: string): PairingInput => {
  const trimmed = rawSchema.parse(raw)

  let url: URL
  try {
    // A bare query string (no scheme) is also accepted — the manual-paste
    // fallback may reasonably not include the `opencharui://pair` prefix.
    url = new URL(trimmed.includes('://') ? trimmed : `opencharui://pair?${trimmed.replace(/^\?/, '')}`)
  } catch {
    throw new Error('Not a valid pairing code')
  }

  if (url.protocol !== 'opencharui:' || url.hostname !== 'pair') {
    throw new Error('Not an OpenCharUI pairing code')
  }

  const version = Number(url.searchParams.get('v'))
  if (version !== 1) {
    throw new Error(`Unsupported pairing code version: ${url.searchParams.get('v') ?? 'missing'}`)
  }

  const relayUrl = url.searchParams.get('r')
  if (!relayUrl) throw new Error('Pairing code is missing the relay URL')
  try {
    const parsed = new URL(relayUrl)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('relay URL must be ws:// or wss://')
    }
  } catch {
    throw new Error('Pairing code has an invalid relay URL')
  }

  const pairIdRaw = url.searchParams.get('i')
  if (!pairIdRaw) throw new Error('Pairing code is missing the pair id')
  const pairId = base64UrlDecode(pairIdRaw)
  if (pairId.length !== PAIR_ID_BYTES) {
    throw new Error(`Pairing code's pair id must decode to ${PAIR_ID_BYTES} bytes, got ${pairId.length}`)
  }

  const pskRaw = url.searchParams.get('k')
  if (!pskRaw) throw new Error('Pairing code is missing the shared secret')
  const psk = base64UrlDecode(pskRaw)
  if (psk.length !== PSK_BYTES) {
    throw new Error(`Pairing code's secret must decode to ${PSK_BYTES} bytes, got ${psk.length}`)
  }

  return { version, relayUrl, pairId, psk }
}
