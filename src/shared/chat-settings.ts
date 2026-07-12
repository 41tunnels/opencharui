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
} => {
  return {
    temperature: chat.temperature ?? character.defaultParams?.temperature,
    topP: chat.topP ?? character.defaultParams?.topP,
    maxTokens: chat.maxTokens ?? character.defaultParams?.maxTokens
  }
}

export const resolveChatContextWindowSize = (chat: Chat): number => {
  return chat.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE
}
