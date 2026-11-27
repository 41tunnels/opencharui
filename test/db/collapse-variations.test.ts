// Only the latest assistant reply offers the variation switcher, so a user
// message that moves the chat on cuts earlier replies down to the variation
// that was showing. The latest reply keeps all of its variations until then.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addMessage,
  addMessageVariation,
  createChat,
  getMessage,
  setActiveVariation
} from '@browser/db/chats'
import { saveCharacter } from '@browser/db/characters'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const makeChat = async (): Promise<string> => {
  const character = await saveCharacter({
    id: crypto.randomUUID(),
    name: 'Elara',
    description: 'A shy cousin'
  } as Parameters<typeof saveCharacter>[0])
  return (await createChat(character.id)).id
}

describe('collapsing assistant variations', () => {
  it('keeps every variation on the latest reply', async () => {
    const chatId = await makeChat()
    await addMessage(chatId, 'user', 'hi')
    const reply = await addMessage(chatId, 'assistant', 'one')
    await addMessageVariation(reply.id, 'two')
    await addMessageVariation(reply.id, 'three')

    expect((await getMessage(reply.id))?.variations).toEqual(['one', 'two', 'three'])
  })

  it('keeps only the active variation once the user replies', async () => {
    const chatId = await makeChat()
    await addMessage(chatId, 'user', 'hi')
    const reply = await addMessage(chatId, 'assistant', 'one')
    await addMessageVariation(reply.id, 'two')
    await addMessageVariation(reply.id, 'three')
    await setActiveVariation(reply.id, 1)

    await addMessage(chatId, 'user', 'and then?')

    const stored = await getMessage(reply.id)
    expect(stored).toMatchObject({ content: 'two', variations: ['two'], activeVariationIndex: 0 })
  })

  it('trims older replies left over from before pruning existed', async () => {
    const chatId = await makeChat()
    await addMessage(chatId, 'user', 'hi')
    const first = await addMessage(chatId, 'assistant', 'a')
    // Simulate a chat saved before pruning: add variations after the next
    // user turn already exists, bypassing the collapse.
    await addMessage(chatId, 'user', 'more')
    const second = await addMessage(chatId, 'assistant', 'b')
    await addMessageVariation(first.id, 'a2')
    await addMessageVariation(second.id, 'b2')

    await addMessage(chatId, 'user', 'again')

    expect((await getMessage(first.id))?.variations).toEqual(['a2'])
    expect((await getMessage(second.id))?.variations).toEqual(['b2'])
  })
})
