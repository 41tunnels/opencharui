// Rolling compaction end to end: a chat that has piled up enough turns
// gets its older ones folded into a summary while the user types, and the
// next reply is generated from that summary plus the recent turns rather
// than the whole history.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendUserMessage } from '@browser/chat-generation'
import { compactChatIfDue } from '@browser/chat-compaction'
import { saveCharacter } from '@browser/db/characters'
import { addMessage, createChat, getChat, setChatModel } from '@browser/db/chats'
import { saveSettings } from '@browser/db/settings'
import { invalidateOllamaBaseUrl } from '@browser/llm/ollama'
import { DEFAULT_COMPACTION_KEEP_RECENT } from '@shared/compaction'

const SUMMARY_TEXT = 'They met at the pool. She promised to bring peach preserves.'

interface Recorded {
  stream: boolean
  messages: Array<{ role: string; content: string }>
  options?: Record<string, unknown>
}

/** Answers /api/ps, streams a reply for the visible generation, and returns
 * a canned summary for the non-streaming call. `delaySummaryMs` holds the
 * summary open so a send can be raced against it. */
const stubOllama = (options: { contextTokens?: number; delaySummaryMs?: number } = {}) => {
  const contextTokens = options.contextTokens ?? 8192
  const calls: Recorded[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/ps')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'test-model', context_length: contextTokens }] }),
        { status: 200 }
      )
    }

    const body = JSON.parse((init?.body as string) ?? '{}')
    calls.push({ stream: Boolean(body.stream), messages: body.messages, options: body.options })

    if (!body.stream) {
      if (options.delaySummaryMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delaySummaryMs))
      }
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

describe('a chat with enough history to compress', () => {
  it('folds the old turns away and generates from the summary', async () => {
    const { calls } = stubOllama()
    const chatId = await makeChatWithHistory(120)

    // What the composer does on a pause in typing.
    const result = await compactChatIfDue(chatId)
    expect(result).not.toBeNull()

    // The summary was written and recorded against the last folded turn.
    const compacted = await getChat(chatId)
    expect(compacted!.summary).toBe(SUMMARY_TEXT)
    expect(compacted!.summarizedThrough).toBeTruthy()
    expect(compacted!.summarizedAt).toBeGreaterThan(0)
    expect(result!.keptVerbatim).toBe(DEFAULT_COMPACTION_KEEP_RECENT)

    await sendUserMessage(chatId, 'What happens next?', { onChunk: () => {} })

    const summarising = calls.filter((c) => !c.stream)
    const generating = calls.filter((c) => c.stream)
    expect(summarising).toHaveLength(1)
    expect(generating).toHaveLength(1)

    // The reply was generated from the summary plus the recent turns: the
    // character block first, then the recap as its own system message.
    const prompt = generating[0].messages
    expect(prompt[0].role).toBe('system')
    expect(prompt[0].content).not.toContain(SUMMARY_TEXT)
    expect(prompt[1].role).toBe('system')
    expect(prompt[1].content).toContain(SUMMARY_TEXT)
    expect(prompt.some((m) => m.content.startsWith('turn 0 '))).toBe(false)
    // Recent turns survive verbatim, and so does the message just sent.
    expect(prompt.length).toBeLessThanOrEqual(DEFAULT_COMPACTION_KEEP_RECENT + 4)
    expect(prompt.at(-1)).toEqual({ role: 'user', content: 'What happens next?' })

    // The raw history is untouched — compaction only changes what is sent.
    const chat = await getChat(chatId)
    expect(chat!.messages.length).toBeGreaterThan(120)
  })

  it('leaves a chat alone until a whole block has piled up', async () => {
    const { calls } = stubOllama({ contextTokens: 65536 })
    const chatId = await makeChatWithHistory(10)

    expect(await compactChatIfDue(chatId)).toBeNull()
    await sendUserMessage(chatId, 'Hello', { onChunk: () => {} })

    expect((await getChat(chatId))!.summary).toBeUndefined()
    expect(calls.filter((c) => !c.stream)).toHaveLength(0)
    expect(calls[0].messages.some((m) => m.content.startsWith('turn 0 '))).toBe(true)
  })

  it('makes a send wait for a compaction that is still running', async () => {
    // Typing fast enough to hit Send mid-pass must not build a prompt from
    // a summary that is about to change — and must not start a second one.
    const { calls } = stubOllama({ delaySummaryMs: 30 })
    const chatId = await makeChatWithHistory(120)

    const compacting = compactChatIfDue(chatId)
    await sendUserMessage(chatId, 'What happens next?', { onChunk: () => {} })
    await compacting

    expect(calls.filter((c) => !c.stream)).toHaveLength(1)
    const prompt = calls.find((c) => c.stream)!.messages
    expect(prompt[1].content).toContain(SUMMARY_TEXT)
  })

  it('joins a pass already in flight rather than starting a second', async () => {
    const { calls } = stubOllama({ delaySummaryMs: 30 })
    const chatId = await makeChatWithHistory(120)

    const results = await Promise.all([
      compactChatIfDue(chatId),
      compactChatIfDue(chatId),
      compactChatIfDue(chatId)
    ])

    expect(calls.filter((c) => !c.stream)).toHaveLength(1)
    expect(results.every((r) => r?.folded === results[0]?.folded)).toBe(true)
  })

  it('summarises with the prompt and sampling from settings', async () => {
    const { calls } = stubOllama()
    await saveSettings({
      compactionPrompt: 'Just list the facts.',
      compactionInterval: 4,
      compactionKeepRecent: 2,
      compactionTemperature: 0.05,
      compactionTopP: 0.5,
      compactionMaxTokens: 128
    })
    const chatId = await makeChatWithHistory(6)

    const result = await compactChatIfDue(chatId)

    expect(result).toEqual({ folded: 4, keptVerbatim: 2, summaryChars: SUMMARY_TEXT.length })
    const summarising = calls.find((c) => !c.stream)!
    expect(summarising.messages[0].content).toBe('Just list the facts.')
    expect(summarising.options).toMatchObject({
      temperature: 0.05,
      top_p: 0.5,
      num_predict: 128
    })
  })

  it('still answers when summarising fails', async () => {
    // A summary that could not be written is a missed optimisation, not a
    // reason to lose the message.
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
    expect(await compactChatIfDue(chatId)).toBeNull()
    await expect(
      sendUserMessage(chatId, 'What happens next?', { onChunk: () => {} })
    ).resolves.toBeTruthy()

    const chat = await getChat(chatId)
    expect(chat!.summary).toBeUndefined()
    expect(chat!.messages.at(-1)!.content).toBe('Still here.')
  })
})
