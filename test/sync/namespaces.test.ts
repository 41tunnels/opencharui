// The single highest-risk correctness detail in the client rewrite: derived
// and volatile fields (Chat.lastMessageAt, StoredCharacter/StoredPersona's
// updatedAt) must never leak into the hashed document, or two devices
// holding identical content diverge and re-push forever.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { putSilent } from '@browser/db/index'
import { characterNamespace, personaNamespace, chatNamespace } from '@browser/sync/namespaces'
import type { StoredCharacter } from '@browser/db/characters'
import type { StoredPersona } from '@browser/db/personas'
import type { Chat, Message } from '@shared/types'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

const CHAR_ID = '11111111-1111-4111-8111-111111111111'
const PERSONA_ID_UNUSED = '22222222-2222-4222-8222-222222222222'
const CHAT_ID = '33333333-3333-4333-8333-333333333333'
const MSG_ID = '44444444-4444-4444-8444-444444444444'

describe('characters/personas: updatedAt is excluded from the hashed document', () => {
  it('two otherwise-identical characters differing only in updatedAt produce identical list() data', async () => {
    const base: Omit<StoredCharacter, 'updatedAt'> = { id: CHAR_ID, name: 'Ada' }
    await putSilent<StoredCharacter>('characters', { ...base, updatedAt: 100 })
    const [first] = await characterNamespace.list()
    await putSilent<StoredCharacter>('characters', { ...base, updatedAt: 999_999 })
    const [second] = await characterNamespace.list()

    expect(JSON.stringify(first.data)).toBe(JSON.stringify(second.data))
    expect(first.updatedAt).toBe(100)
    expect(second.updatedAt).toBe(999_999)
    expect(JSON.stringify(first.data)).not.toContain('updatedAt')
  })

  it('same for personas', async () => {
    const base: Omit<StoredPersona, 'updatedAt'> = { id: PERSONA_ID_UNUSED, name: 'Sam' }
    await putSilent<StoredPersona>('personas', { ...base, updatedAt: 100 })
    const [first] = await personaNamespace.list()
    await putSilent<StoredPersona>('personas', { ...base, updatedAt: 999_999 })
    const [second] = await personaNamespace.list()

    expect(JSON.stringify(first.data)).toBe(JSON.stringify(second.data))
  })
})

describe('chats: lastMessageAt (derived) and updatedAt are excluded from the hashed document', () => {
  const baseChat: Omit<Chat, 'updatedAt' | 'lastMessageAt'> = {
    id: CHAT_ID,
    characterId: CHAR_ID,
    title: 'Chat with Ada',
    modelId: null,
    provider: null,
    createdAt: 100
  }
  const message: Message = {
    id: MSG_ID,
    chatId: CHAT_ID,
    role: 'user',
    content: 'hi',
    createdAt: 150
  }

  it('a chat carrying lastMessageAt hashes identically to one that does not', async () => {
    await putSilent<Message>('messages', message)

    await putSilent<Chat>('chats', { ...baseChat, updatedAt: 200, lastMessageAt: 150 })
    const [withDerived] = await chatNamespace.list()

    await putSilent<Chat>('chats', { ...baseChat, updatedAt: 500 })
    const [withoutDerived] = await chatNamespace.list()

    expect(JSON.stringify(withDerived.data)).toBe(JSON.stringify(withoutDerived.data))
    expect(JSON.stringify(withDerived.data)).not.toContain('lastMessageAt')
    expect(JSON.stringify(withDerived.data)).not.toContain('"updatedAt"')
  })

  it('messages are sorted by createdAt before hashing regardless of insertion order', async () => {
    const second: Message = { ...message, id: '55555555-5555-4555-8555-555555555555', content: 'second', createdAt: 300 }
    const first: Message = { ...message, content: 'first', createdAt: 200 }

    // Insert out of order.
    await putSilent<Message>('messages', second)
    await putSilent<Message>('messages', first)
    await putSilent<Chat>('chats', { ...baseChat, updatedAt: 100 })

    const [record] = await chatNamespace.list()
    const data = record.data as { messages: Message[] }
    expect(data.messages.map((m) => m.content)).toEqual(['first', 'second'])
  })
})
