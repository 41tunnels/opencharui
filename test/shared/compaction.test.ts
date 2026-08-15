// When a chat gets compacted, and which turns get folded in.
//
// A long chat otherwise sends every message every turn: the prompt grows
// until it fills the model's window, replies get squeezed into whatever is
// left, and each turn pays to re-read the whole history.
import { describe, expect, it } from 'vitest'
import {
  KEEP_RECENT_MESSAGES,
  MIN_COMPACTION_BLOCK,
  buildSummaryInstruction,
  planCompaction,
  renderFoldedTranscript
} from '@shared/compaction'

const history = (count: number, chars = 800) =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i}`.padEnd(chars, 'x')
  }))

describe('planCompaction', () => {
  it('leaves a chat alone while it fits comfortably', () => {
    const plan = planCompaction({
      messages: history(30),
      fixedTokens: 3000,
      contextTokens: 65536
    })

    expect(plan).toBeNull()
  })

  it('folds the oldest turns once the prompt passes half the window', () => {
    const messages = history(200)
    const plan = planCompaction({ messages, fixedTokens: 3000, contextTokens: 32768 })

    expect(plan).not.toBeNull()
    expect(plan!.keeping).toBe(KEEP_RECENT_MESSAGES)
    expect(plan!.fold).toHaveLength(messages.length - KEEP_RECENT_MESSAGES)
    // Oldest first, and the marker is the last message folded.
    expect(plan!.fold[0].id).toBe('m0')
    expect(plan!.through).toBe(plan!.fold.at(-1)!.id)
  })

  it('only considers history the summary does not already cover', () => {
    const messages = history(200)
    const plan = planCompaction({
      messages,
      summarizedThrough: 'm149',
      fixedTokens: 3000,
      contextTokens: 32768
    })

    // 50 messages left uncompacted, 40 of them kept: 10 to fold, which is
    // under the block size, so the prefix is left alone.
    expect(plan).toBeNull()
  })

  it('waits for a full block rather than rewriting the summary every turn', () => {
    // Rewriting the summary changes the prompt prefix, and Ollama can only
    // reuse its KV cache while that prefix is unchanged — measured at 88s
    // against 8s on a 36k-token chat.
    const justUnder = KEEP_RECENT_MESSAGES + MIN_COMPACTION_BLOCK - 1
    expect(
      planCompaction({ messages: history(justUnder, 4000), fixedTokens: 0, contextTokens: 1000 })
    ).toBeNull()

    const justOver = KEEP_RECENT_MESSAGES + MIN_COMPACTION_BLOCK
    expect(
      planCompaction({ messages: history(justOver, 4000), fixedTokens: 0, contextTokens: 1000 })
    ).not.toBeNull()
  })

  it('treats a summary pointing at a deleted message as covering nothing', () => {
    const messages = history(200)
    const plan = planCompaction({
      messages,
      summarizedThrough: 'gone',
      fixedTokens: 3000,
      contextTokens: 32768
    })

    // Better to re-fold from the start than to silently drop every turn
    // before a marker that no longer exists.
    expect(plan!.fold[0].id).toBe('m0')
  })

  it('counts the system block and summary against the window too', () => {
    const messages = history(60)
    const roomy = planCompaction({ messages, fixedTokens: 1000, contextTokens: 65536 })
    const crowded = planCompaction({ messages, fixedTokens: 60000, contextTokens: 65536 })

    expect(roomy).toBeNull()
    expect(crowded).not.toBeNull()
  })
})

describe('summarisation prompt', () => {
  it('labels each turn with the speaker so the model can tell them apart', () => {
    const transcript = renderFoldedTranscript(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' }
      ],
      { character: 'Elara', user: 'John' }
    )

    expect(transcript).toBe('John: Hello\n\nElara: Hi there')
  })

  it('folds an existing summary into the next one rather than starting over', () => {
    const instruction = buildSummaryInstruction('They met at the pool.')

    expect(instruction).toContain('They met at the pool.')
    expect(instruction).toMatch(/keeping everything from it that is still true/i)
  })

  it('asks for facts, not narration, and forbids invention', () => {
    const instruction = buildSummaryInstruction()

    expect(instruction).toMatch(/invent nothing/i)
    expect(instruction).toMatch(/promised/i)
    expect(instruction).not.toContain('EXISTING SUMMARY')
  })
})
