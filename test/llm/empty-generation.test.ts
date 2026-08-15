// A generation that produces no reply must not be persisted as an empty
// assistant message.
//
// This is what a thinking model does at the default 512-token budget: the
// reasoning pass spends every token (`done_reason: "length"`) and the
// reply never starts. The empty string used to be saved anyway, leaving a
// blank bubble in the chat that was then sent back to the model as an
// empty assistant turn on the next request.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyGenerationError, sendUserMessage } from '@browser/chat-generation'
import { saveCharacter } from '@browser/db/characters'
import { createChat, getMessages, setChatModel } from '@browser/db/chats'
import { saveSettings } from '@browser/db/settings'
import { invalidateOllamaBaseUrl } from '@browser/llm/ollama'

const ndjson = (lines: object[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(line) + '\n'))
      }
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

async function makeChat(): Promise<string> {
  const character = await saveCharacter({
    id: crypto.randomUUID(),
    name: 'Test Character',
    description: 'A character',
    greeting: 'Hello'
  } as Parameters<typeof saveCharacter>[0])
  const chat = await createChat(character.id)
  await setChatModel(chat.id, 'test-model', 'ollama')
  return chat.id
}

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  await saveSettings({ ollamaUrl: 'http://ollama.test' })
  invalidateOllamaBaseUrl()
})

afterEach(() => {
  vi.unstubAllGlobals()
  invalidateOllamaBaseUrl()
})

describe('a generation with no reply text', () => {
  it('reports the reasoning-only case instead of saving a blank message', async () => {
    // Reasoning until the token budget runs out, and not one character of
    // reply — exactly what the default 512 produced with a character card.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjson([
          { message: { role: 'assistant', content: '', thinking: 'Considering...' } },
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' }
        ])
      )
    )

    const chatId = await makeChat()
    const thinking: string[] = []

    await expect(
      sendUserMessage(chatId, 'Hi there', {
        onChunk: () => {},
        onThinking: (delta) => thinking.push(delta)
      })
    ).rejects.toThrow(EmptyGenerationError)

    // The reasoning reached the UI, so the wait was not a silent one.
    expect(thinking.join('')).toBe('Considering...')

    // The greeting and the user's message are kept; no blank assistant
    // turn is appended after them.
    const messages = await getMessages(chatId)
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user'])
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true)
  })

  it('still saves a reply that arrives after the reasoning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjson([
          { message: { role: 'assistant', content: '', thinking: 'Considering...' } },
          { message: { role: 'assistant', content: 'Hello!' }, done: true }
        ])
      )
    )

    const chatId = await makeChat()
    await sendUserMessage(chatId, 'Hi there', { onChunk: () => {} })

    const messages = await getMessages(chatId)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['assistant', 'Hello'], // the character's greeting, seeded with the chat
      ['user', 'Hi there'],
      ['assistant', 'Hello!']
    ])
  })
})
