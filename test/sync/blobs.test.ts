import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toBlobRefs, fromBlobRefs } from '@browser/sync/blobs'
import { sha256HexBytes } from '@browser/sync/hash'
import { saveSettings } from '@browser/db/settings'
import { invalidateOllamaBaseUrl } from '@browser/llm/ollama'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  invalidateOllamaBaseUrl()
  await saveSettings({ ollamaUrl: 'http://amallo.test', ollamaApiKey: 'k' })
})

const bigDataUrl = (mime: string, size: number): string => {
  const bytes = new Uint8Array(size).map((_, i) => i % 256)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:${mime};base64,${btoa(bin)}`
}

describe('sync/blobs: toBlobRefs', () => {
  it('leaves a small data URL (below the min-bytes threshold) untouched', async () => {
    const small = bigDataUrl('image/png', 100)
    const pending = new Map<string, Uint8Array>()
    const out = await toBlobRefs({ avatar: small }, pending)
    expect(out).toEqual({ avatar: small })
    expect(pending.size).toBe(0)
  })

  it('replaces a large data URL with a $blob ref and collects its bytes', async () => {
    const large = bigDataUrl('image/png', 10_000)
    const pending = new Map<string, Uint8Array>()
    const out = (await toBlobRefs({ avatar: large }, pending)) as { avatar: { $blob: string; mime: string; size: number } }
    expect(out.avatar.$blob).toMatch(/^[0-9a-f]{64}$/)
    expect(out.avatar.mime).toBe('image/png')
    expect(out.avatar.size).toBe(10_000)
    expect(pending.size).toBe(1)
    expect(pending.get(out.avatar.$blob)?.length).toBe(10_000)
  })

  it('walks arrays and nested objects', async () => {
    const large = bigDataUrl('image/png', 10_000)
    const pending = new Map<string, Uint8Array>()
    const out = (await toBlobRefs({ list: [{ img: large }, 'plain'] }, pending)) as {
      list: [{ img: unknown }, string]
    }
    expect(pending.size).toBe(1)
    expect((out.list[0].img as { $blob: string }).$blob).toMatch(/^[0-9a-f]{64}$/)
    expect(out.list[1]).toBe('plain')
  })

  it('leaves non-data-url strings untouched', async () => {
    const pending = new Map<string, Uint8Array>()
    const out = await toBlobRefs({ name: 'Ada', note: 'data:not-really-a-match' }, pending)
    expect(out).toEqual({ name: 'Ada', note: 'data:not-really-a-match' })
    expect(pending.size).toBe(0)
  })
})

describe('sync/blobs: fromBlobRefs', () => {
  it('downloads and reconstructs a data URL byte-exactly, then caches it', async () => {
    const large = bigDataUrl('image/png', 10_000)
    const pending = new Map<string, Uint8Array>()
    const ref = (await toBlobRefs({ avatar: large }, pending)) as { avatar: { $blob: string } }
    const bytes = pending.get(ref.avatar.$blob)!

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`http://amallo.test/extended/v1/blob/${ref.avatar.$blob}`)
      return new Response(bytes.slice().buffer, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const hydrated = (await fromBlobRefs(ref)) as { avatar: string }
    expect(hydrated.avatar).toBe(large)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Second resolution hits the IndexedDB cache, not the network.
    const hydratedAgain = (await fromBlobRefs(ref)) as { avatar: string }
    expect(hydratedAgain.avatar).toBe(large)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })

  it('drops the field on a 404 rather than failing the whole document', async () => {
    const hash = await sha256HexBytes(new Uint8Array([1, 2, 3]))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    )

    const doc = { name: 'Ada', avatar: { $blob: hash, mime: 'image/png', size: 3 } }
    const hydrated = (await fromBlobRefs(doc)) as Record<string, unknown>
    expect(hydrated.name).toBe('Ada')
    expect('avatar' in hydrated).toBe(false)

    vi.unstubAllGlobals()
  })

  it('drops the field when the network throws (e.g. offline) rather than throwing itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error')
      })
    )
    const doc = { avatar: { $blob: 'a'.repeat(64), mime: 'image/png', size: 3 } }
    const hydrated = (await fromBlobRefs(doc)) as Record<string, unknown>
    expect('avatar' in hydrated).toBe(false)
    vi.unstubAllGlobals()
  })
})
