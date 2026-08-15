// Trimming a prompt so the reply has somewhere to go.
//
// The per-chat history window counts messages, not tokens, so a long chat
// hands the model a prompt that fills its context and leaves a couple of
// hundred tokens to answer in — `done_reason: "length"`, cut off
// mid-sentence, with nothing in the response saying so.
import { describe, expect, it } from 'vitest'
import { estimatePromptTokens, fitMessagesToContext } from '@shared/context-usage'

const msg = (role: 'system' | 'user' | 'assistant', chars: number, tag = 'x') => ({
  role,
  content: tag.repeat(chars)
})

describe('fitMessagesToContext', () => {
  it('leaves a prompt that already fits untouched', () => {
    const messages = [msg('system', 400), msg('user', 400), msg('assistant', 400), msg('user', 400)]
    const result = fitMessagesToContext(messages, { contextTokens: 4096, reserveTokens: 512 })

    expect(result.dropped).toBe(0)
    expect(result.messages).toEqual(messages)
  })

  it('drops the oldest history until the reply budget is free', () => {
    // 40 turns of 400 characters each: ~100 tokens per message against a
    // 2048-token window that must keep 512 free.
    const history = Array.from({ length: 40 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 400, String(i % 10))
    )
    const messages = [msg('system', 400), ...history]

    const result = fitMessagesToContext(messages, { contextTokens: 2048, reserveTokens: 512 })

    expect(result.dropped).toBeGreaterThan(0)
    expect(estimatePromptTokens(result.messages)).toBeLessThanOrEqual(2048 - 512)
    // Dropped from the front: the newest turns are the ones that matter.
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
  })

  it('keeps the system prompt and the final turn whatever happens', () => {
    const system = msg('system', 4000, 's')
    const last = msg('user', 4000, 'q')
    const messages = [system, msg('assistant', 4000, 'a'), msg('user', 4000, 'b'), last]

    const result = fitMessagesToContext(messages, { contextTokens: 2048, reserveTokens: 512 })

    // Without the character there is no character, and without the final
    // turn there is nothing to answer.
    expect(result.messages[0]).toEqual(system)
    expect(result.messages.at(-1)).toEqual(last)
  })

  it('gives up rather than looping when even the essentials do not fit', () => {
    const messages = [msg('system', 40_000, 's'), msg('user', 40_000, 'q')]
    const result = fitMessagesToContext(messages, { contextTokens: 2048, reserveTokens: 512 })

    expect(result.messages).toHaveLength(2)
    expect(result.dropped).toBe(0)
  })

  it('treats a reserve larger than the context as nothing it can fix', () => {
    const messages = [msg('user', 400)]
    const result = fitMessagesToContext(messages, { contextTokens: 512, reserveTokens: 4096 })

    expect(result.messages).toEqual(messages)
    expect(result.dropped).toBe(0)
  })

  it('handles a prompt with no leading system message', () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 400, String(i % 10))
    )
    const result = fitMessagesToContext(history, { contextTokens: 2048, reserveTokens: 512 })

    expect(result.dropped).toBeGreaterThan(0)
    expect(estimatePromptTokens(result.messages)).toBeLessThanOrEqual(2048 - 512)
    expect(result.messages.at(-1)).toEqual(history.at(-1))
  })
})
