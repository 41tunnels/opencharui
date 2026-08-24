import { resolveChatSystemPrompt } from './chat-settings'
import { buildSummaryPart, buildSystemContent, historyAfterSummary } from './prompt-builder'
import type { Character, Chat, Message, Persona } from './types'

const CHARS_PER_TOKEN = 4
const MESSAGE_OVERHEAD_TOKENS = 4

export interface ContextUsage {
  usedTokens: number
  limitTokens: number
  percent: number
}

export const estimateTokenCount = (text: string): number => {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export const estimatePromptTokens = (
  messages: Array<{ role: string; content: string }>
): number => {
  return messages.reduce(
    (sum, message) => sum + estimateTokenCount(message.content) + MESSAGE_OVERHEAD_TOKENS,
    0
  )
}

export const computeContextUsage = (params: {
  chat: Pick<Chat, 'systemPrompt'>
  globalSystemPrompt: string
  character: Character
  persona?: Persona
  messages: Message[]
  historyWindow: number
  modelContextTokens: number
  draftInput?: string
  /** The chat's rolling summary, so the gauge measures the prompt that is
   * actually sent rather than the whole history. */
  summary?: string
  summarizedThrough?: string
}): ContextUsage => {
  const systemPrompt = resolveChatSystemPrompt(params.chat as Chat, params.globalSystemPrompt)
  const history = historyAfterSummary(params.messages, params.summarizedThrough)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-params.historyWindow)

  const system = buildSystemContent(systemPrompt, params.character, params.persona)
  const summaryPart = buildSummaryPart(params.summary)
  const promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...(summaryPart ? [{ role: 'system' as const, content: summaryPart }] : []),
    ...history.map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content
    }))
  ]

  const draft = params.draftInput?.trim()
  if (draft) {
    promptMessages.push({ role: 'user', content: draft })
  }

  const usedTokens = estimatePromptTokens(promptMessages)
  const limitTokens = params.modelContextTokens
  const percent = limitTokens > 0 ? Math.round((usedTokens / limitTokens) * 100) : 0

  return { usedTokens, limitTokens, percent }
}

export const formatContextUsageLabel = (usage: ContextUsage): string => {
  return `${usage.percent}% context`
}

/**
 * Drops the oldest history until the prompt leaves `reserveTokens` of the
 * context window free for the reply.
 *
 * The per-chat history window is a count of messages, which says nothing
 * about how much room is left to answer: a long enough chat fills the
 * whole window with prompt, and the model then stops after whatever few
 * tokens remain — `done_reason: "length"`, mid-sentence. Ollama truncates
 * silently in that case, so nothing downstream can tell this happened.
 *
 * The leading system messages and the final turn are never dropped: without
 * them the model has no character and no question to answer. The whole
 * leading run is pinned, not just the first — a compacted chat sends the
 * "story so far" as a second system message, and trimming that would throw
 * away the very turns it was written to preserve. If those alone exceed the
 * budget there is nothing useful left to trim, and the prompt is returned
 * as-is for the server to deal with.
 *
 * `estimateTokenCount` runs about a quarter high against a real tokenizer,
 * which is the safe direction here — it trims a little more than strictly
 * necessary rather than overshooting the window.
 */
export const fitMessagesToContext = <T extends { role: string; content: string }>(
  messages: T[],
  options: { contextTokens: number; reserveTokens: number }
): { messages: T[]; dropped: number } => {
  const budget = options.contextTokens - options.reserveTokens
  if (budget <= 0 || estimatePromptTokens(messages) <= budget) {
    return { messages, dropped: 0 }
  }

  let headLength = 0
  while (headLength < messages.length && messages[headLength].role === 'system') headLength++
  const head = messages.slice(0, headLength)
  const rest = messages.slice(headLength)
  const last = rest.slice(-1)
  const middle = rest.slice(0, Math.max(0, rest.length - 1))

  let dropped = 0
  while (
    dropped < middle.length &&
    estimatePromptTokens([...head, ...middle.slice(dropped), ...last]) > budget
  ) {
    dropped++
  }

  return { messages: [...head, ...middle.slice(dropped), ...last], dropped }
}

export const formatTokenSpeed = (tokens: number, elapsedMs: number): string | null => {
  if (tokens <= 0 || elapsedMs < 300) return null

  const perSecond = tokens / (elapsedMs / 1000)
  return perSecond >= 10 ? `${Math.round(perSecond)} tok/s` : `${perSecond.toFixed(1)} tok/s`
}
