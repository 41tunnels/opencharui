// Deciding *when* to compact a chat and *which* turns to fold in.
//
// Kept free of IO so the policy can be tested directly: the browser module
// (`browser/chat-compaction.ts`) supplies the numbers and performs the
// summarisation this returns a plan for.

/**
 * Compact once this many messages have accumulated beyond what the summary
 * already covers (and beyond the recent turns kept verbatim).
 *
 * This is what makes compaction *chunked*, and it matters for more than
 * tidiness: Ollama reuses its KV cache only for an unchanged prompt
 * prefix, and the summary sits in the prefix. Rewriting it every turn
 * costs a full re-read of the prompt each time — measured at 88s against
 * 8s for a reused prefix on a 36k-token chat. Folding a block at a time
 * keeps the prefix identical for many turns.
 */
export const DEFAULT_COMPACTION_INTERVAL = 30

/** Turns kept verbatim after a compaction. Recent detail is what a reply
 * is actually built from; the summary carries the rest. */
export const DEFAULT_COMPACTION_KEEP_RECENT = 10

/** Low, because this is a recall task. Sampling creatively here invents
 * events that the story is then obliged to honour. */
export const DEFAULT_COMPACTION_TEMPERATURE = 0.2

/** Ollama's own default, stated explicitly so the settings UI has a number
 * to show rather than an empty box. */
export const DEFAULT_COMPACTION_TOP_P = 0.9

/** Room the summary itself is allowed to take. Deliberately small: it is
 * read every turn for the rest of the chat's life. */
export const DEFAULT_COMPACTION_MAX_TOKENS = 1024

/**
 * Asks for facts rather than prose. A narrated recap reads well and loses
 * exactly what a roleplay needs to stay consistent — who knows what, who
 * promised what, where everyone is and what state they are in.
 *
 * Editable in global settings; this is only the starting point.
 */
export const DEFAULT_COMPACTION_PROMPT = `Summarise the transcript below as compact notes that let a writer continue the story without having read it.

Cover, only where the transcript establishes them:
- Who the characters are to each other, and how that has changed
- What each has said they want, promised, or agreed to
- Anything unresolved that the story is still heading towards
- Details that would be jarring to contradict: names, clothing, injuries, gifts, plans

Rules:
- Write only what the transcript supports. Invent nothing.
- Past tense, third person, no dialogue, no commentary about summarising.
- Terse notes, grouped under short headings`

export interface CompactionInput {
  /** History in order, oldest first, excluding system messages. */
  messages: Array<{ id: string; role: string; content: string }>
  /** Id of the last message the current summary covers, if any. */
  summarizedThrough?: string
  /** Fold once this many messages are foldable — see
   * DEFAULT_COMPACTION_INTERVAL for why it waits for a whole block. */
  interval: number
  /** Never fold the last this-many messages. */
  keepRecent: number
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
 * Returns the block to fold into the summary, or null when too little
 * uncompacted history has accrued to be worth rewriting the prefix for.
 *
 * With the defaults (interval 30, keepRecent 10) a chat of 100 messages
 * folds 1–90 and keeps 91–100 verbatim; nothing happens again until
 * message 130, which folds 91–120 into the summary written before.
 */
export const planCompaction = (input: CompactionInput): CompactionPlan | null => {
  const { messages, summarizedThrough, interval, keepRecent } = input
  if (interval < 1) return null

  const startIndex = summarizedThrough
    ? messages.findIndex((m) => m.id === summarizedThrough) + 1
    : 0
  // A summary pointing at a message that no longer exists (deleted turn)
  // covers nothing knowable, so treat the history as uncompacted.
  const uncompacted = startIndex > 0 ? messages.slice(startIndex) : messages

  const foldable = uncompacted.length - Math.max(0, keepRecent)
  if (foldable < interval) return null

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
 * The system message for a summarisation call: the user's (editable)
 * instruction, with the previous summary prepended so each pass folds the
 * story so far forward instead of starting over.
 */
export const buildSummaryInstruction = (prompt: string, previousSummary?: string): string => {
  const carryOver = previousSummary?.trim()
    ? `An earlier summary of this story is below. Fold the new transcript into it, keeping everything from it that is still true.\n\nEXISTING SUMMARY:\n${previousSummary.trim()}\n\n`
    : ''

  return `${carryOver}${prompt.trim()}`
}
