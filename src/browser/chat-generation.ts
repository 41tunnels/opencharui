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
  resolveChatSystemPrompt,
  toOllamaKeepAlive
} from '@shared/chat-settings'
import { fitMessagesToContext } from '@shared/context-usage'
import type { Message } from '@shared/types'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Room kept free for the reply when neither the chat nor the character
 * sets a max — Ollama would otherwise generate until the context runs out,
 * which is precisely the case that leaves nothing to generate into. */
const DEFAULT_RESERVED_REPLY_TOKENS = 512

export interface StreamCallbacks {
  onChunk: (delta: string) => void
  /** Reasoning deltas from a thinking model. Shown as progress, never
   * persisted and never fed back as history — see `ChatThinkingEvent`. */
  onThinking?: (delta: string) => void
}

/**
 * Thrown when a generation ends with nothing to show. A thinking model
 * that spends its whole budget reasoning is the usual cause, and the
 * previous behaviour — persisting the empty string — left a blank bubble
 * in the chat that then went back to the model as an empty assistant turn.
 */
export class EmptyGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyGenerationError'
  }
}

export class ChatCancelledError extends Error {
  constructor(message = 'Chat deleted') {
    super(message)
    this.name = 'ChatCancelledError'
  }
}

/**
 * Thrown by `streamAssistantReply` instead of the raw transport error when
 * generation stops mid-stream (a dropped relay/network connection) with at
 * least one token already received — `content` is what streamed in before
 * the failure. Callers persist it as a truncated message (so the partial
 * reply isn't silently lost) and then re-throw `cause`, the original
 * error, so the existing error UI still reports what actually went wrong.
 */
export class PartialGenerationError extends Error {
  readonly content: string
  constructor(content: string, options: { cause?: unknown }) {
    super('Generation ended early with partial content', options)
    this.name = 'PartialGenerationError'
    this.content = content
  }
}

export const isPartialGenerationError = (err: unknown): err is PartialGenerationError =>
  err instanceof PartialGenerationError

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
  generationParams: {
    temperature?: number
    topP?: number
    maxTokens?: number
    keepAliveMinutes?: number
  },
  callbacks: StreamCallbacks
): Promise<string> => {
  const controller = new AbortController()
  activeGenerations.set(chatId, controller)

  let assistantContent = ''
  let sawThinking = false
  try {
    await assertChatExists(chatId)
    const { modelId } = await resolveModel(chatId)

    // The history window is a message count, so a long chat can hand the
    // model a prompt that fills its context and leaves no room to answer.
    // Trim against the window the model is actually loaded with, keeping
    // the reply's budget free.
    const contextTokens = await ollama.getModelContextLength(modelId)
    const reserveTokens = generationParams.maxTokens ?? DEFAULT_RESERVED_REPLY_TOKENS
    const fitted = fitMessagesToContext(messages, { contextTokens, reserveTokens })
    if (fitted.dropped > 0) {
      console.log(
        `[chat] dropped ${fitted.dropped} old message(s) to keep ${reserveTokens} tokens free for the reply (context ${contextTokens})`
      )
    }

    try {
      await ollama.chat(
        {
          modelId,
          messages: fitted.messages,
          temperature: generationParams.temperature,
          topP: generationParams.topP,
          maxTokens: generationParams.maxTokens,
          keepAlive: toOllamaKeepAlive(generationParams.keepAliveMinutes)
        },
        {
          onToken: (delta) => {
            if (controller.signal.aborted) {
              ollama.abortChat()
              return
            }
            assistantContent += delta
            callbacks.onChunk(delta)
          },
          onThinking: (delta) => {
            if (controller.signal.aborted) {
              ollama.abortChat()
              return
            }
            sawThinking = true
            callbacks.onThinking?.(delta)
          }
        },
        controller.signal
      )
    } catch (err) {
      // An intentional stop (controller.signal.aborted) surfaces from
      // ollama.chat() as a raw AbortError, not a ChatCancelledError —
      // normalize it here so isChatCancelledError recognizes it downstream
      // instead of it being reported as a generation error.
      if (controller.signal.aborted) {
        throw new ChatCancelledError()
      }
      // A real transport failure (dropped relay/network connection) with
      // at least one token already streamed: let the caller persist what
      // arrived instead of discarding it, then still surface the real error.
      if (assistantContent) {
        throw new PartialGenerationError(assistantContent, { cause: err })
      }
      throw err
    }

    if (controller.signal.aborted || !(await getChat(chatId))) {
      throw new ChatCancelledError()
    }

    if (!assistantContent.trim()) {
      throw new EmptyGenerationError(
        sawThinking
          ? 'The model finished reasoning without writing a reply. Raise max tokens, or try again.'
          : 'The model returned an empty reply. Try again.'
      )
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

  try {
    const assistantContent = await streamAssistantReply(
      chatId,
      messages,
      generationParams,
      callbacks
    )
    await assertChatExists(chatId)
    const assistantMessage = await addMessage(chatId, 'assistant', assistantContent)
    return { messageId: assistantMessage.id }
  } catch (err) {
    if (isPartialGenerationError(err) && (await getChat(chatId))) {
      await addMessage(chatId, 'assistant', err.content, { truncated: true })
      throw err.cause
    }
    throw err
  }
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
  try {
    const content = await streamAssistantReply(
      chatId,
      promptMessages.messages,
      promptMessages.generationParams,
      callbacks
    )
    await assertChatExists(chatId)
    const updated = await addMessageVariation(lastAssistant.id, content)
    return { messageId: updated.id, content: updated.content }
  } catch (err) {
    if (isPartialGenerationError(err) && (await getChat(chatId))) {
      await addMessageVariation(lastAssistant.id, err.content, { truncated: true })
      throw err.cause
    }
    throw err
  }
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

  try {
    const assistantContent = await streamAssistantReply(
      chatId,
      promptMessages,
      generationParams,
      callbacks
    )
    await assertChatExists(chatId)
    const assistantMessage = await addMessage(chatId, 'assistant', assistantContent)
    return { message: updated, regenerated: true, messageId: assistantMessage.id }
  } catch (err) {
    if (isPartialGenerationError(err) && (await getChat(chatId))) {
      await addMessage(chatId, 'assistant', err.content, { truncated: true })
      throw err.cause
    }
    throw err
  }
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
