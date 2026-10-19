// The last three assistant replies are editable, not only the latest one.
// Anything older, or already folded into the chat summary, is refused: the
// summary is what reaches the model for those turns, so an edit there would
// look saved but change nothing.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { editAssistantMessage } from '@browser/chat-generation'
import { addMessage, createChat, getMessages, saveChatSummary } from '@browser/db/chats'
import { saveCharacter } from '@browser/db/characters'
import { editableAssistantMessageIds } from '@shared/message-editing'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

/** A chat with four user/assistant exchanges; returns the assistant ids, oldest first. */
const makeChat = async (): Promise<{ chatId: string; assistantIds: string[] }> => {
  const character = await saveCharacter({
    id: crypto.randomUUID(),
    name: 'Elara',
    description: 'A shy cousin'
  } as Parameters<typeof saveCharacter>[0])
  const chat = await createChat(character.id)
  const assistantIds: string[] = []
  for (let i = 1; i <= 4; i += 1) {
    await addMessage(chat.id, 'user', `question ${i}`)
    assistantIds.push((await addMessage(chat.id, 'assistant', `answer ${i}`)).id)
  }
  return { chatId: chat.id, assistantIds }
}

describe('editing older assistant messages', () => {
  it('allows the last three replies and stores the edit', async () => {
    const { chatId, assistantIds } = await makeChat()

    const updated = await editAssistantMessage(chatId, assistantIds[1]!, 'answer 2, revised')
    expect(updated.content).toBe('answer 2, revised')
    expect(updated.variations).toEqual(['answer 2, revised'])

    const stored = (await getMessages(chatId)).find((m) => m.id === assistantIds[1])
    expect(stored?.content).toBe('answer 2, revised')
  })

  it('refuses the fourth reply back', async () => {
    const { chatId, assistantIds } = await makeChat()
    await expect(editAssistantMessage(chatId, assistantIds[0]!, 'nope')).rejects.toThrow(
      /last 3 replies/
    )
  })

  it('refuses a reply already folded into the summary', async () => {
    const { chatId, assistantIds } = await makeChat()
    await saveChatSummary(chatId, 'They talked.', assistantIds[1]!)

    const messages = await getMessages(chatId)
    expect([...editableAssistantMessageIds(messages, assistantIds[1])]).toEqual(
      assistantIds.slice(2)
    )
    await expect(editAssistantMessage(chatId, assistantIds[1]!, 'nope')).rejects.toThrow()
    await expect(editAssistantMessage(chatId, assistantIds[2]!, 'fine')).resolves.toMatchObject({
      content: 'fine'
    })
  })
})
