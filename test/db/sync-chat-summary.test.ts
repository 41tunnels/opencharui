// A chat's rolling summary has to survive a sync round trip. It is stored
// on the chat record, and the apply path rebuilds that record field by
// field — so anything it forgets is silently dropped the next time the
// chat comes back from another device, and the chat quietly goes back to
// sending its whole history.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { addMessage, applySyncedChat, createChat, getChat, saveChatSummary } from '@browser/db/chats'
import { saveCharacter } from '@browser/db/characters'
import { chatNamespace } from '@browser/sync/namespaces'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

const makeChat = async (): Promise<string> => {
  const character = await saveCharacter({
    id: crypto.randomUUID(),
    name: 'Elara',
    description: 'A shy cousin'
  } as Parameters<typeof saveCharacter>[0])
  const chat = await createChat(character.id)
  await addMessage(chat.id, 'user', 'first')
  await addMessage(chat.id, 'assistant', 'second')
  return chat.id
}

describe('chat summary and sync', () => {
  it('survives a list -> apply round trip', async () => {
    const chatId = await makeChat()
    const messages = (await getChat(chatId))!.messages
    await saveChatSummary(chatId, 'They met at the pool.', messages[0].id)

    const listed = await chatNamespace.list()
    const record = listed.find((r) => r.key === chatId)!

    // Serialised for the wire...
    expect(record.data).toMatchObject({
      summary: 'They met at the pool.',
      summarizedThrough: messages[0].id
    })

    // ...and restored when it comes back from another device.
    await chatNamespace.applyData(chatId, record.data, Date.now())
    const restored = await getChat(chatId)
    expect(restored!.summary).toBe('They met at the pool.')
    expect(restored!.summarizedThrough).toBe(messages[0].id)
  })

  it('applying a chat without a summary clears the local one', async () => {
    const chatId = await makeChat()
    const messages = (await getChat(chatId))!.messages
    await saveChatSummary(chatId, 'Older notes.', messages[0].id)

    const listed = await chatNamespace.list()
    const { summary: _dropped, ...withoutSummary } = listed.find((r) => r.key === chatId)!
      .data as Record<string, unknown>
    await applySyncedChat(
      { ...(withoutSummary as Parameters<typeof applySyncedChat>[0]) },
      Date.now()
    )

    // A device that cleared its summary must be able to propagate that,
    // rather than having the old one linger locally forever.
    expect((await getChat(chatId))!.summary).toBeUndefined()
  })
})
