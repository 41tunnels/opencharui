// When a chat gets compacted, and which turns get folded in.
//
// A long chat otherwise sends every message every turn: the prompt grows
// until it fills the model's window, replies get squeezed into whatever is
// left, and each turn pays to re-read the whole history.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_INTERVAL,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_PROMPT,
  buildSummaryInstruction,
  planCompaction,
  renderFoldedTranscript
} from '@shared/compaction'

const X = DEFAULT_COMPACTION_INTERVAL
const Y = DEFAULT_COMPACTION_KEEP_RECENT

const history = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`
  }))

const plan = (count: number, summarizedThrough?: string) =>
  planCompaction({ messages: history(count), summarizedThrough, interval: X, keepRecent: Y })

describe('planCompaction', () => {
  it('leaves a chat alone until a whole block is foldable', () => {
    // Rewriting the summary changes the prompt prefix, and Ollama can only
    // reuse its KV cache while that prefix is unchanged — measured at 88s
    // against 8s on a 36k-token chat. So it waits for a full block.
    expect(plan(X + Y - 1)).toBeNull()
    expect(plan(X + Y)).not.toBeNull()
  })

  it('folds everything except the most recent turns', () => {
    const result = plan(X + Y)

    expect(result!.fold).toHaveLength(X)
    expect(result!.keeping).toBe(Y)
    expect(result!.fold[0].id).toBe('m0')
    expect(result!.through).toBe(result!.fold.at(-1)!.id)
  })

  it('follows the worked example: 100 messages fold 1-90, then nothing until 130', () => {
    // Index i is message i + 1, so message 90 is `m89`.
    const first = plan(100)
    expect(first!.fold).toHaveLength(90)
    expect(first!.through).toBe('m89')
    expect(first!.keeping).toBe(10)

    // Nothing more to do until another X + Y have arrived.
    expect(plan(129, 'm89')).toBeNull()

    const second = plan(130, 'm89')
    expect(second!.fold.map((m) => m.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `m${90 + i}`)
    )
    expect(second!.through).toBe('m119')
    expect(second!.keeping).toBe(10)
  })

  it('only considers history the summary does not already cover', () => {
    // 20 messages left uncompacted, 10 of them kept: 10 to fold, which is
    // under the block size, so the prefix is left alone.
    expect(plan(200, 'm179')).toBeNull()
  })

  it('treats a summary pointing at a deleted message as covering nothing', () => {
    // Better to re-fold from the start than to silently drop every turn
    // before a marker that no longer exists.
    expect(plan(200, 'gone')!.fold[0].id).toBe('m0')
  })

  it('folds everything but the kept turns when the chat has run far ahead', () => {
    // Compaction disabled, or repeatedly failing: the next pass catches up
    // in one block rather than staying permanently behind.
    const result = plan(500)
    expect(result!.fold).toHaveLength(500 - Y)
    expect(result!.keeping).toBe(Y)
  })

  it('never folds when the interval is meaningless', () => {
    expect(planCompaction({ messages: history(200), interval: 0, keepRecent: Y })).toBeNull()
  })

  it('folds every message when nothing is kept back', () => {
    const result = planCompaction({ messages: history(30), interval: X, keepRecent: 0 })
    expect(result!.fold).toHaveLength(30)
    expect(result!.keeping).toBe(0)
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
    const instruction = buildSummaryInstruction(DEFAULT_COMPACTION_PROMPT, 'They met at the pool.')

    expect(instruction).toContain('They met at the pool.')
    expect(instruction).toMatch(/keeping everything from it that is still true/i)
    expect(instruction).toContain(DEFAULT_COMPACTION_PROMPT)
  })

  it('uses the prompt the user configured', () => {
    const instruction = buildSummaryInstruction('Just list the facts.')

    expect(instruction).toBe('Just list the facts.')
    expect(instruction).not.toContain('EXISTING SUMMARY')
  })

  it('asks for facts, not narration, and forbids invention by default', () => {
    expect(DEFAULT_COMPACTION_PROMPT).toMatch(/invent nothing/i)
    expect(DEFAULT_COMPACTION_PROMPT).toMatch(/promised/i)
  })
})
