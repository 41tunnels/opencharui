// How a compacted chat is turned into a prompt: the summary rides in the
// system block, and only the turns after it are sent verbatim.
import { describe, expect, it } from 'vitest'
import { buildMessages, historyAfterSummary } from '@shared/prompt-builder'
import type { Character, Message } from '@shared/types'

const character = { id: 'c1', name: 'Elara', description: 'A shy cousin' } as Character

const message = (id: string, role: 'user' | 'assistant', content: string): Message =>
  ({ id, chatId: 'chat', role, content, createdAt: 0 }) as Message

const history = [
  message('m1', 'user', 'first'),
  message('m2', 'assistant', 'second'),
  message('m3', 'user', 'third'),
  message('m4', 'assistant', 'fourth')
]

describe('historyAfterSummary', () => {
  it('keeps only what the summary does not cover', () => {
    expect(historyAfterSummary(history, 'm2').map((m) => m.id)).toEqual(['m3', 'm4'])
  })

  it('keeps everything when there is no summary', () => {
    expect(historyAfterSummary(history, undefined)).toHaveLength(4)
  })

  it('keeps everything when the marker no longer exists', () => {
    // The covered message was deleted. Sending the full history is wrong
    // in a small way; dropping every turn before an unknown marker would
    // be wrong in a large one.
    expect(historyAfterSummary(history, 'deleted')).toHaveLength(4)
  })
})

describe('buildMessages with a summary', () => {
  it('puts the summary in the system message and drops the folded turns', () => {
    const prompt = buildMessages('Stay in character.', character, undefined, history, 'now what?', 20, {
      summary: 'They met at the pool and argued.',
      summarizedThrough: 'm2'
    })

    expect(prompt[0].role).toBe('system')
    expect(prompt[0].content).toContain('They met at the pool and argued.')
    expect(prompt[0].content).toMatch(/story so far/i)

    // m1/m2 are represented by the summary now, not by their own turns.
    expect(prompt.map((m) => m.content)).not.toContain('first')
    expect(prompt.map((m) => m.content)).not.toContain('second')
    expect(prompt.map((m) => m.content)).toContain('third')
    expect(prompt.at(-1)).toEqual({ role: 'user', content: 'now what?' })
  })

  it('is unchanged from before when no summary exists', () => {
    const withoutCompaction = buildMessages('Stay in character.', character, undefined, history, 'now what?', 20)
    const withEmpty = buildMessages('Stay in character.', character, undefined, history, 'now what?', 20, {})

    expect(withEmpty).toEqual(withoutCompaction)
    expect(withoutCompaction.map((m) => m.content)).toContain('first')
    expect(withoutCompaction[0].content).not.toMatch(/story so far/i)
  })

  it('shrinks the prompt substantially once older turns are folded', () => {
    const long = Array.from({ length: 100 }, (_, i) =>
      message(`x${i}`, i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(800))
    )
    const full = buildMessages('Stay in character.', character, undefined, long, 'next', 300)
    const compacted = buildMessages('Stay in character.', character, undefined, long, 'next', 300, {
      summary: 'A short recap.',
      summarizedThrough: 'x59'
    })

    const chars = (m: Array<{ content: string }>) => m.reduce((n, x) => n + x.content.length, 0)
    expect(chars(compacted)).toBeLessThan(chars(full) / 2)
  })
})
