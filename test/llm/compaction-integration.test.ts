// Rolling compaction end to end: a chat that has outgrown its window gets
// its older turns folded into a summary, and the next reply is generated
// from that summary plus the recent turns rather than the whole history.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendUserMessage } from '@browser/chat-generation'
import { saveCharacter } from '@browser/db/characters'
import { addMessage, createChat, getChat, setChatModel } from '@browser/db/chats'
import { saveSettings } from '@browser/db/settings'
import { invalidateOllamaBaseUrl } from '@browser/llm/ollama'
import { KEEP_RECENT_MESSAGES } from '@shared/compaction'

const SUMMARY_TEXT = 'They met at the pool. She promised to bring peach preserves.'

interface Recorded {
  stream: boolean
  messages: Array<{ role: string; content: string }>
}

/** Answers /api/ps with a small window, streams a reply for the visible
 * generation, and returns a canned summary for the non-streaming call. */
const stubOllama = (contextTokens: number) => {
  const calls: Recorded[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/ps')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'test-model', context_length: contextTokens }] }),
        { status: 200 }
      )
    }

    const body = JSON.parse((init?.body as string) ?? '{}')
    calls.push({ stream: Boolean(body.stream), messages: body.messages })

    if (!body.stream) {
      return new Response(JSON.stringify({ message: { content: SUMMARY_TEXT } }), { status: 200 })
    }

    const line = JSON.stringify({ message: { content: 'A reply.' }, done: true }) + '\n'
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(line))
          controller.close()
        }
      }),
      { status: 200 }
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}

async function makeChatWithHistory(messageCount: number): Promise<string> {
  const character = await saveCharacter({
    id: crypto.randomUUID(),
    name: 'Elara',
    description: 'A shy cousin'
  } as Parameters<typeof saveCharacter>[0])
  const chat = await createChat(character.id)
  await setChatModel(chat.id, 'test-model', 'ollama')

  for (let i = 0; i < messageCount; i++) {
    await addMessage(chat.id, i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ` + 'x'.repeat(800))
  }
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

describe('a chat that has outgrown its context window', () => {
  it('folds the old turns away and generates from the summary', async () => {
    const { calls } = stubOllama(8192)
    const chatId = await makeChatWithHistory(120)

    await sendUserMessage(chatId, 'What happens next?', { onChunk: () => {} })

    // The summary was written and recorded against the last folded turn.
    const chat = await getChat(chatId)
    expect(chat!.summary).toBe(SUMMARY_TEXT)
    expect(chat!.summarizedThrough).toBeTruthy()
    expect(chat!.summarizedAt).toBeGreaterThan(0)

    const summarising = calls.filter((c) => !c.stream)
    const generating = calls.filter((c) => c.stream)
    expect(summarising).toHaveLength(1)
    expect(generating).toHaveLength(1)

    // The reply was generated from the summary plus the recent turns.
    const prompt = generating[0].messages
    expect(prompt[0].role).toBe('system')
    expect(prompt[0].content).toContain(SUMMARY_TEXT)
    expect(prompt.some((m) => m.content.startsWith('turn 0 '))).toBe(false)
    // Recent turns survive verbatim, and so does the message just sent.
    expect(prompt.length).toBeLessThanOrEqual(KEEP_RECENT_MESSAGES + 3)
    expect(prompt.at(-1)).toEqual({ role: 'user', content: 'What happens next?' })

    // The raw history is untouched — compaction only changes what is sent.
    expect(chat!.messages.length).toBeGreaterThan(120)
  })

  it('leaves a short chat alone', async () => {
    const { calls } = stubOllama(65536)
    const chatId = await makeChatWithHistory(10)

    await sendUserMessage(chatId, 'Hello', { onChunk: () => {} })

    expect((await getChat(chatId))!.summary).toBeUndefined()
    expect(calls.filter((c) => !c.stream)).toHaveLength(0)
    expect(calls[0].messages.some((m) => m.content.startsWith('turn 0 '))).toBe(true)
  })

  it('still answers when summarising fails', async () => {
    // A summary that could not be written is a missed optimisation, not a
    // reason to lose the user's message.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'test-model', context_length: 8192 }] }),
          { status: 200 }
        )
      }
      const body = JSON.parse((init?.body as string) ?? '{}')
      if (!body.stream) return new Response('upstream exploded', { status: 500 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ message: { content: 'Still here.' }, done: true }) + '\n'
              )
            )
            controller.close()
          }
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const chatId = await makeChatWithHistory(120)
    await expect(
      sendUserMessage(chatId, 'What happens next?', { onChunk: () => {} })
    ).resolves.toBeTruthy()

    const chat = await getChat(chatId)
    expect(chat!.summary).toBeUndefined()
    expect(chat!.messages.at(-1)!.content).toBe('Still here.')
  })
})
