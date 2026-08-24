import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSettings } from '@browser/db/settings'
import { invalidateOllamaBaseUrl } from '@browser/llm/ollama'
import { saveCharacter, getCharacter } from '@browser/db/characters'
import { addMessage, createChat, getChat } from '@browser/db/chats'
import { characterNamespace, chatNamespace } from '@browser/sync/namespaces'
import { getSyncStatus, syncNow } from '@browser/sync/engine'
import * as meta from '@browser/sync/meta'
import { createFakeServer, installFetchMock, type FakeServer } from './fake-server'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  invalidateOllamaBaseUrl()
  // A direct connection with an API key satisfies the sync engine's auth
  // gate without touching the relay module at all.
  await saveSettings({ ollamaUrl: 'http://amallo.test', ollamaApiKey: 'k' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const setup = (): FakeServer => {
  const server = createFakeServer()
  installFetchMock(server)
  return server
}

describe('sync engine: push/pull round trip', () => {
  it('pushes a new local character and records an ack', async () => {
    const server = setup()
    await saveCharacter({ id: crypto.randomUUID(), name: 'Ada' })

    const status = await syncNow()

    expect(status.state).toBe('idle')
    expect(server.records.size).toBe(1)
    const [[, record]] = server.records
    expect(record.namespace).toBe('characters')
    expect(record.deleted).toBe(false)

    const acks = await meta.getAllAcks()
    expect(acks).toHaveLength(1)
    expect(acks[0].hash).toBe(record.hash)
  })

  it('pulls a remote-only character into an empty local store', async () => {
    const server = setup()
    const remoteId = crypto.randomUUID()
    const { sha256Hex } = await import('@browser/sync/hash')
    const data = { id: remoteId, name: 'Bea' }
    await server.handlePush({
      records: [{ namespace: 'characters', key: remoteId, hash: await sha256Hex(JSON.stringify(data)), updatedAt: 100, data }]
    })

    const status = await syncNow()
    expect(status.state).toBe('idle')
    const local = await getCharacter(remoteId)
    expect(local?.name).toBe('Bea')
  })
})

describe('sync engine: the missed-write fix', () => {
  it('pushes a second edit to the same record on the next pass — content hash, not a clock window, gates the push', async () => {
    const server = setup()
    const id = crypto.randomUUID()
    await saveCharacter({ id, name: 'Ada' })
    await syncNow()
    expect(server.records.get(`characters:${id}`)?.data).toMatchObject({ name: 'Ada' })

    // A second, different edit to the SAME id.
    await saveCharacter({ id, name: 'Ada Lovelace' })
    const status = await syncNow()

    expect(status.state).toBe('idle')
    expect(server.records.get(`characters:${id}`)?.data).toMatchObject({ name: 'Ada Lovelace' })
  })

  it('does not re-push unchanged content (converges to duplicate, not a growing seq)', async () => {
    const server = setup()
    const id = crypto.randomUUID()
    await saveCharacter({ id, name: 'Ada' })
    await syncNow()
    const seqAfterFirst = server.records.get(`characters:${id}`)?.seq

    // Nothing changed locally — a second pass must not push again.
    await syncNow()
    expect(server.records.get(`characters:${id}`)?.seq).toBe(seqAfterFirst)
  })
})

describe('sync engine: apply order', () => {
  it('applies a lower-ranked namespace (characters) before a higher-ranked one (chats) even when the chat has a lower seq', async () => {
    const server = setup()
    const charId = crypto.randomUUID()
    const chatId = crypto.randomUUID()

    // Push the CHAT first (seq 1), then the CHARACTER it references (seq
    // 2) — the server assigns seq purely in push order and enforces no
    // referential integrity, so this is a legitimate, realistic ordering.
    const chatData = {
      id: chatId,
      characterId: charId,
      title: 'Chat',
      modelId: null,
      provider: null,
      createdAt: 100,
      messages: []
    }
    const charData = { id: charId, name: 'Ada' }
    const { sha256Hex } = await import('@browser/sync/hash')
    await server.handlePush({
      records: [{ namespace: 'chats', key: chatId, hash: await sha256Hex(JSON.stringify(chatData)), updatedAt: 100, data: chatData }]
    })
    await server.handlePush({
      records: [{ namespace: 'characters', key: charId, hash: await sha256Hex(JSON.stringify(charData)), updatedAt: 100, data: charData }]
    })

    const charSpy = vi.spyOn(characterNamespace, 'applyData')
    const chatSpy = vi.spyOn(chatNamespace, 'applyData')

    const status = await syncNow()
    expect(status.state).toBe('idle')
    expect(charSpy).toHaveBeenCalledTimes(1)
    expect(chatSpy).toHaveBeenCalledTimes(1)
    expect(charSpy.mock.invocationCallOrder[0]).toBeLessThan(chatSpy.mock.invocationCallOrder[0])
  })
})

describe('sync engine: direction', () => {
  // Push runs before pull, so a pulled record is normally either newer than
  // the local copy or the local copy's own echo. The exception is the window
  // between the two — a reply streaming in, a message typed — where the pull
  // response describes a chat that is already out of date by the time it
  // lands. Applying it there is not a merge: `applySyncedChat` drops the
  // chat's whole message list and rewrites it from the payload.
  const scriptedClock = (start = 1_000_000): { advance: (ms: number) => void } => {
    let now = start
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    return { advance: (ms: number) => { now += ms } }
  }

  /** Re-routes fetch so `during` runs once, before the first pull resolves. */
  const injectDuringPull = (during: () => Promise<void>): void => {
    const routed = globalThis.fetch as typeof fetch
    let fired = false
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      if (!fired && String(input).includes('/extended/v1/pull')) {
        fired = true
        await during()
      }
      return routed(input, init)
    })
  }

  const seedSyncedChat = async (clock: { advance: (ms: number) => void }): Promise<string> => {
    const character = await saveCharacter({ id: crypto.randomUUID(), name: 'Elara' })
    const chat = await createChat(character.id)
    clock.advance(1000)
    await addMessage(chat.id, 'user', 'first')
    await syncNow()
    return chat.id
  }

  it('keeps locally-newer messages and pushes them back instead of applying a staler server copy', async () => {
    const server = setup()
    const clock = scriptedClock()
    const chatId = await seedSyncedChat(clock)

    // Another device renames the chat: a real edit with a newer envelope,
    // made without ever seeing the message this device is about to write.
    const { sha256Hex } = await import('@browser/sync/hash')
    const stored = server.records.get(`chats:${chatId}`)!
    const renamed = { ...(stored.data as Record<string, unknown>), title: 'Renamed elsewhere' }
    await server.handlePush({
      records: [{ namespace: 'chats', key: chatId, hash: await sha256Hex(JSON.stringify(renamed)), updatedAt: 1_002_000, data: renamed }]
    })

    injectDuringPull(async () => {
      clock.advance(5000)
      await addMessage(chatId, 'assistant', 'streamed mid-pass')
    })

    const status = await syncNow()
    expect(status.state).toBe('idle')

    const local = await getChat(chatId)
    expect(local!.messages.map((m) => m.content)).toEqual(['first', 'streamed mid-pass'])

    // ...and the same pass carried it the other way, so the two sides agree.
    const after = server.records.get(`chats:${chatId}`)!
    expect((after.data as { messages: unknown[] }).messages).toHaveLength(2)
    expect(after.deleted).toBe(false)
  })

  it('still applies a server copy that is genuinely newer', async () => {
    const server = setup()
    const clock = scriptedClock()
    const chatId = await seedSyncedChat(clock)

    const { sha256Hex } = await import('@browser/sync/hash')
    const stored = server.records.get(`chats:${chatId}`)!
    const base = stored.data as { messages: Record<string, unknown>[] }
    const withReply = {
      ...(stored.data as Record<string, unknown>),
      messages: [
        ...base.messages,
        { id: crypto.randomUUID(), chatId, role: 'assistant', content: 'answered elsewhere', createdAt: 1_004_000 }
      ]
    }
    await server.handlePush({
      records: [{ namespace: 'chats', key: chatId, hash: await sha256Hex(JSON.stringify(withReply)), updatedAt: 1_004_000, data: withReply }]
    })

    const status = await syncNow()
    expect(status.state).toBe('idle')
    const local = await getChat(chatId)
    expect(local!.messages.map((m) => m.content)).toEqual(['first', 'answered elsewhere'])
  })

  it('declines a tombstone that predates the local messages, and resurrects the chat server-side', async () => {
    const server = setup()
    const clock = scriptedClock()
    const chatId = await seedSyncedChat(clock)

    const { EMPTY_HASH } = await import('@browser/sync/hash')
    await server.handlePush({
      records: [{ namespace: 'chats', key: chatId, hash: EMPTY_HASH, updatedAt: 1_002_000, deleted: true }]
    })

    injectDuringPull(async () => {
      clock.advance(5000)
      await addMessage(chatId, 'user', 'still talking here')
    })

    const status = await syncNow()
    expect(status.state).toBe('idle')

    const local = await getChat(chatId)
    expect(local).not.toBeNull()
    expect(local!.messages.map((m) => m.content)).toEqual(['first', 'still talking here'])

    const after = server.records.get(`chats:${chatId}`)!
    expect(after.deleted).toBe(false)
    expect((after.data as { messages: unknown[] }).messages).toHaveLength(2)
  })
})

describe('sync engine: request contract', () => {
  it('every request carries an AbortSignal — the fix for the offline-relay hang', async () => {
    const server = createFakeServer()
    const { calls } = installFetchMock(server)
    await saveCharacter({ id: crypto.randomUUID(), name: 'Ada' })
    await syncNow()

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('maps a fetch rejection to an error status rather than hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error')
      })
    )
    await saveCharacter({ id: crypto.randomUUID(), name: 'Ada' })
    const status = await syncNow()
    expect(status.state).toBe('error')
  })

  it('a 404 (older amallo without /extended/v1) surfaces as unsupported, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    )
    const status = await syncNow()
    expect(status.state).toBe('unsupported')
  })
})

describe('sync engine: store identity change forces a full resync', () => {
  it('a changed storeId resets acks and cursor', async () => {
    const server = setup()
    const id = crypto.randomUUID()
    await saveCharacter({ id, name: 'Ada' })
    await syncNow()
    expect(await meta.getAllAcks()).toHaveLength(1)

    // Simulate the server being wiped/replaced: a fresh store with a new id.
    const fresh = createFakeServer()
    installFetchMock(fresh)
    await syncNow()

    // The old ack for a store that no longer exists must not survive —
    // the record gets pushed again as new content to the fresh store.
    expect(fresh.records.size).toBe(1)
  })
})

it('getSyncStatus reflects the disabled state before any successful sync', async () => {
  invalidateOllamaBaseUrl()
  await saveSettings({ ollamaUrl: '', ollamaApiKey: '' })
  const status = getSyncStatus()
  expect(status).toBeDefined()
})
