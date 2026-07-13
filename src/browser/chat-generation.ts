import { getCharacter } from './db/characters'
import {
  addMessage,
  addMessageVariation,
  getChat,
  getMessages,
  renameChat,
  setActiveVariation,
  setChatModel,
  updateAssistantMessageContent,
  updateMessageContent
} from './db/chats'
import { getSettings } from './db/settings'
import * as ollama from './llm/ollama'
import { buildMessages, buildOpeningMessages, deriveChatTitle, renderCharacterTemplate } from '@shared/prompt-builder'
import {
  resolveChatGenerationParams,
  resolveChatContextWindowSize,
  resolveChatSystemPrompt
} from '@shared/chat-settings'
import type { Message } from '@shared/types'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface StreamCallbacks {
  onChunk: (delta: string) => void
}

export class ChatCancelledError extends Error {
  constructor(message = 'Chat deleted') {
    super(message)
    this.name = 'ChatCancelledError'
  }
}

const activeGenerations = new Map<string, AbortController>()

const assertChatExists = async (chatId: string): Promise<void> => {
  if (!(await getChat(chatId))) {
    throw new ChatCancelledError()
  }
}

export const abortGeneration = (chatId: string): void => {
  ollama.abortChat()
  activeGenerations.get(chatId)?.abort()
  activeGenerations.delete(chatId)
}

export const cancelGenerationForChat = (chatId: string): void => {
  abortGeneration(chatId)
}

const resolveModel = async (chatId: string): Promise<{ modelId: string }> => {
  await assertChatExists(chatId)
  const chat = (await getChat(chatId))!
  const modelId = chat.modelId ?? (await ollama.getDefaultModelId())
  if (!modelId) {
    throw new Error('No model available. Start Ollama and pull a model.')
  }

  if (!chat.modelId) {
    await setChatModel(chatId, modelId, 'ollama')
  }

  return { modelId }
}

const resolvePromptContext = async (chatId: string) => {
  const chat = (await getChat(chatId))!
  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')
  const settings = await getSettings()
  return {
    chat,
    character,
    persona: chat.persona,
    systemPrompt: resolveChatSystemPrompt(chat, settings.systemPrompt),
    contextWindowSize: resolveChatContextWindowSize(chat),
    generationParams: resolveChatGenerationParams(chat, character)
  }
}

const streamAssistantReply = async (
  chatId: string,
  messages: ChatMessage[],
  generationParams: { temperature?: number; topP?: number; maxTokens?: number },
  callbacks: StreamCallbacks
): Promise<string> => {
  const controller = new AbortController()
  activeGenerations.set(chatId, controller)

  let assistantContent = ''
  try {
    await assertChatExists(chatId)
    const { modelId } = await resolveModel(chatId)

    await ollama.chat(
      {
        modelId,
        messages,
        temperature: generationParams.temperature,
        topP: generationParams.topP,
        maxTokens: generationParams.maxTokens
      },
      (delta) => {
        if (controller.signal.aborted) {
          ollama.abortChat()
          return
        }
        assistantContent += delta
        callbacks.onChunk(delta)
      },
      controller.signal
    )

    if (controller.signal.aborted || !(await getChat(chatId))) {
      throw new ChatCancelledError()
    }

    return assistantContent
  } finally {
    activeGenerations.delete(chatId)
  }
}

export const generateOpeningMessage = async (
  chatId: string
): Promise<{ messageId: string; content: string } | null> => {
  await assertChatExists(chatId)
  const chat = (await getChat(chatId))!
  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')

  const existingAssistant = (await getMessages(chatId)).find((message) => message.role === 'assistant')
  if (existingAssistant) {
    return { messageId: existingAssistant.id, content: existingAssistant.content }
  }

  const greeting = character.greeting?.trim()
  if (!greeting) {
    return null
  }

  const renderedGreeting = renderCharacterTemplate(greeting, character, chat.persona)
  const assistantMessage = await addMessage(chatId, 'assistant', renderedGreeting)
  await renameChat(chatId, deriveChatTitle(renderedGreeting))
  return { messageId: assistantMessage.id, content: renderedGreeting }
}

export const sendUserMessage = async (
  chatId: string,
  content: string,
  callbacks: StreamCallbacks
): Promise<{ messageId: string }> => {
  await assertChatExists(chatId)
  const chat = (await getChat(chatId))!
  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')

  const { systemPrompt, persona, contextWindowSize, generationParams } =
    await resolvePromptContext(chatId)
  await addMessage(chatId, 'user', content)

  const userMessages = (await getMessages(chatId)).filter((message) => message.role === 'user')
  if (userMessages.length === 1) {
    await renameChat(chatId, deriveChatTitle(content))
  }

  const history = (await getMessages(chatId)).filter((message) => message.role !== 'system')
  const messages = buildMessages(
    systemPrompt,
    character,
    persona,
    history.slice(0, -1),
    content,
    contextWindowSize
  )

  const assistantContent = await streamAssistantReply(chatId, messages, generationParams, callbacks)
  await assertChatExists(chatId)
  const assistantMessage = await addMessage(chatId, 'assistant', assistantContent)
  return { messageId: assistantMessage.id }
}

const buildRegenerationPrompt = async (
  chatId: string,
  lastAssistantId: string
): Promise<{ messages: ChatMessage[]; generationParams: ReturnType<typeof resolveChatGenerationParams> }> => {
  const { systemPrompt, character, persona, contextWindowSize, generationParams } =
    await resolvePromptContext(chatId)
  const messages = await getMessages(chatId)
  const assistantIndex = messages.findIndex((message) => message.id === lastAssistantId)
  if (assistantIndex === -1) throw new Error('Assistant message not found')

  const historyBefore = messages
    .slice(0, assistantIndex)
    .filter((message) => message.role !== 'system')
  const hasUserBefore = historyBefore.some((message) => message.role === 'user')

  if (!hasUserBefore) {
    return {
      messages: buildOpeningMessages(systemPrompt, character, persona),
      generationParams
    }
  }

  const lastUser = historyBefore[historyBefore.length - 1]
  if (lastUser.role !== 'user') {
    throw new Error('Expected a user message before the assistant reply')
  }

  return {
    messages: buildMessages(
      systemPrompt,
      character,
      persona,
      historyBefore.slice(0, -1),
      lastUser.content,
      contextWindowSize
    ),
    generationParams
  }
}

export const regenerateLastAssistantMessage = async (
  chatId: string,
  callbacks: StreamCallbacks
): Promise<{ messageId: string; content: string }> => {
  await assertChatExists(chatId)
  const chat = (await getChat(chatId))!
  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')

  const messages = await getMessages(chatId)
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!lastAssistant) throw new Error('No assistant message to regenerate')

  const promptMessages = await buildRegenerationPrompt(chatId, lastAssistant.id)
  const content = await streamAssistantReply(
    chatId,
    promptMessages.messages,
    promptMessages.generationParams,
    callbacks
  )
  await assertChatExists(chatId)
  const updated = await addMessageVariation(lastAssistant.id, content)
  return { messageId: updated.id, content: updated.content }
}

export const editLastUserMessage = async (
  chatId: string,
  content: string,
  callbacks: StreamCallbacks
): Promise<{ message: Message; regenerated: boolean; messageId?: string }> => {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('Message cannot be empty')

  const chat = await getChat(chatId)
  if (!chat) throw new Error('Chat not found')

  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')

  const messages = await getMessages(chatId)
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  if (!lastUser) throw new Error('No user message to edit')

  const updated = await updateMessageContent(lastUser.id, trimmed)

  const userMessages = (await getMessages(chatId)).filter((message) => message.role === 'user')
  if (userMessages.length === 1) {
    await renameChat(chatId, deriveChatTitle(trimmed))
  }

  const messagesAfterEdit = await getMessages(chatId)
  const lastMessage = messagesAfterEdit[messagesAfterEdit.length - 1]
  const isLastInChat = lastMessage?.id === updated.id

  if (!isLastInChat || activeGenerations.has(chatId)) {
    return { message: updated, regenerated: false }
  }

  const { systemPrompt, persona, contextWindowSize, generationParams } =
    await resolvePromptContext(chatId)
  const history = messagesAfterEdit.filter((message) => message.role !== 'system')
  const promptMessages = buildMessages(
    systemPrompt,
    character,
    persona,
    history.slice(0, -1),
    trimmed,
    contextWindowSize
  )

  const assistantContent = await streamAssistantReply(
    chatId,
    promptMessages,
    generationParams,
    callbacks
  )
  await assertChatExists(chatId)
  const assistantMessage = await addMessage(chatId, 'assistant', assistantContent)
  return { message: updated, regenerated: true, messageId: assistantMessage.id }
}

export const editLastAssistantMessage = async (chatId: string, content: string): Promise<Message> => {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('Message cannot be empty')

  const chat = await getChat(chatId)
  if (!chat) throw new Error('Chat not found')

  const messages = await getMessages(chatId)
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!lastAssistant) throw new Error('No assistant message to edit')

  return updateAssistantMessageContent(lastAssistant.id, trimmed)
}

export const selectMessageVariation = async (
  chatId: string,
  messageId: string,
  direction: 'prev' | 'next'
): Promise<Message> => {
  const chat = await getChat(chatId)
  if (!chat) throw new Error('Chat not found')

  const message = (await getMessages(chatId)).find((entry) => entry.id === messageId)
  if (!message) throw new Error('Message not found')
  if (message.role !== 'assistant') throw new Error('Only assistant messages support variations')

  const variationCount = message.variations?.length ?? 1
  const currentIndex = message.activeVariationIndex ?? 0
  const nextIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1

  if (nextIndex < 0 || nextIndex >= variationCount) {
    throw new Error('Variation index out of range')
  }

  return setActiveVariation(messageId, nextIndex)
}

export const isChatCancelledError = (err: unknown): err is ChatCancelledError => {
  return err instanceof ChatCancelledError
}
