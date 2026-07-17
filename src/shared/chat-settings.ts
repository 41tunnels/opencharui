import type { Character, Chat } from './types'

export const DEFAULT_CONTEXT_WINDOW_SIZE = 20

export const resolveChatSystemPrompt = (chat: Chat, globalSystemPrompt: string): string => {
  const global = globalSystemPrompt.trim()
  const chatPrompt = chat.systemPrompt?.trim()
  if (global && chatPrompt) return `${global}\n\n${chatPrompt}`
  return global || chatPrompt || ''
}

export const resolveChatGenerationParams = (
  chat: Chat,
  character: Character
): {
  temperature?: number
  topP?: number
  maxTokens?: number
  keepAliveMinutes?: number
} => {
  return {
    temperature: chat.temperature ?? character.defaultParams?.temperature,
    topP: chat.topP ?? character.defaultParams?.topP,
    maxTokens: chat.maxTokens ?? character.defaultParams?.maxTokens,
    keepAliveMinutes: chat.keepAliveMinutes
  }
}

/** Convert chat keep-alive minutes to Ollama's keep_alive value. */
export const toOllamaKeepAlive = (minutes?: number): string | number | undefined => {
  if (minutes === undefined) return undefined
  if (minutes === 0 || minutes === -1) return minutes
  return `${minutes}m`
}

export const resolveChatContextWindowSize = (chat: Chat): number => {
  return chat.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE
}
