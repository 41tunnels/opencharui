// Deciding *when* to compact a chat and *which* turns to fold in.
//
// Kept free of IO so the policy can be tested directly: the browser module
// (`browser/chat-compaction.ts`) supplies the numbers and performs the
// summarisation this returns a plan for.
import { estimatePromptTokens } from './context-usage'

/** Compact once the prompt passes this share of the model's window. Half
 * leaves the other half for the reply and for the turns that will accrue
 * before the next compaction — compacting later would mean compacting more
 * often, since each pass has less room to grow into. */
export const COMPACT_AT_FRACTION = 0.5

/** Turns kept verbatim after a compaction. Recent detail is what a reply
 * is actually built from; the summary carries the rest. */
export const KEEP_RECENT_MESSAGES = 40

/**
 * Never rewrite the summary for fewer than this many messages.
 *
 * This is what makes compaction *chunked*, and it matters for more than
 * tidiness: Ollama reuses its KV cache only for an unchanged prompt
 * prefix, and the summary sits in the prefix. Rewriting it every turn
 * costs a full re-read of the prompt each time — measured at 88s against
 * 8s for a reused prefix on a 36k-token chat. Folding a block at a time
 * keeps the prefix identical for many turns.
 */
export const MIN_COMPACTION_BLOCK = 20

export interface CompactionInput {
  /** History in order, oldest first, excluding system messages. */
  messages: Array<{ id: string; role: string; content: string }>
  /** Id of the last message the current summary covers, if any. */
  summarizedThrough?: string
  /** Tokens the rest of the prompt costs — system block, current summary,
   * and the turn about to be sent. */
  fixedTokens: number
  /** The window the model is actually loaded with. */
  contextTokens: number
}

export interface CompactionPlan {
  /** Messages to fold into the summary, oldest first. */
  fold: Array<{ id: string; role: string; content: string }>
  /** Id of the last folded message — the new `summarizedThrough`. */
  through: string
  /** Messages that stay verbatim, for reporting. */
  keeping: number
}

/**
 * Returns the block to fold into the summary, or null when the chat is
 * comfortably inside its window (or has too little uncompacted history to
 * be worth rewriting the prefix for).
 */
export const planCompaction = (input: CompactionInput): CompactionPlan | null => {
  const { messages, summarizedThrough, fixedTokens, contextTokens } = input
  if (contextTokens <= 0) return null

  const startIndex = summarizedThrough
    ? messages.findIndex((m) => m.id === summarizedThrough) + 1
    : 0
  // A summary pointing at a message that no longer exists (deleted turn)
  // covers nothing knowable, so treat the history as uncompacted.
  const uncompacted = startIndex > 0 ? messages.slice(startIndex) : messages

  const promptTokens = fixedTokens + estimatePromptTokens(uncompacted)
  if (promptTokens <= contextTokens * COMPACT_AT_FRACTION) return null

  const foldable = Math.max(0, uncompacted.length - KEEP_RECENT_MESSAGES)
  if (foldable < MIN_COMPACTION_BLOCK) return null

  const fold = uncompacted.slice(0, foldable)
  return {
    fold,
    through: fold[fold.length - 1].id,
    keeping: uncompacted.length - foldable
  }
}

/** The transcript handed to the model for summarising, oldest first. */
export const renderFoldedTranscript = (
  fold: Array<{ role: string; content: string }>,
  names: { character: string; user: string }
): string => {
  return fold
    .map((m) => `${m.role === 'assistant' ? names.character : names.user}: ${m.content}`)
    .join('\n\n')
}

/**
 * Asks for facts rather than prose. A narrated recap reads well and loses
 * exactly what a roleplay needs to stay consistent — who knows what, who
 * promised what, where everyone is and what state they are in.
 */
export const buildSummaryInstruction = (previousSummary?: string): string => {
  const carryOver = previousSummary?.trim()
    ? `An earlier summary of this story is below. Fold the new transcript into it, keeping everything from it that is still true.\n\nEXISTING SUMMARY:\n${previousSummary.trim()}\n\n`
    : ''

  return `${carryOver}Summarise the transcript below as compact notes that let a writer continue the story without having read it.

Cover, only where the transcript establishes them:
- Who the characters are to each other, and how that has changed
- Where they are, the time of day, and what is physically happening
- What each has said they want, promised, or agreed to
- Anything unresolved that the story is still heading towards
- Details that would be jarring to contradict: names, clothing, injuries, gifts, plans

Rules:
- Write only what the transcript supports. Invent nothing.
- Past tense, third person, no dialogue, no commentary about summarising.
- Terse notes, grouped under short headings. No more than 400 words.`
}
