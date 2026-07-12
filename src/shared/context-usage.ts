import { resolveChatSystemPrompt } from './chat-settings'
import { buildSystemContent } from './prompt-builder'
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
}): ContextUsage => {
  const systemPrompt = resolveChatSystemPrompt(params.chat as Chat, params.globalSystemPrompt)
  const history = params.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-params.historyWindow)

  const system = buildSystemContent(systemPrompt, params.character, params.persona)
  const promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
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

export const formatTokenSpeed = (tokens: number, elapsedMs: number): string | null => {
  if (tokens <= 0 || elapsedMs < 300) return null

  const perSecond = tokens / (elapsedMs / 1000)
  return perSecond >= 10 ? `${Math.round(perSecond)} tok/s` : `${perSecond.toFixed(1)} tok/s`
}
