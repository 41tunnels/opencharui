import {
  get,
  getAll,
  put,
  putSilent,
  deleteByKey,
  deleteByKeySilent,
  getAllByIndex,
  deleteMessagesForChat
} from './index'
import { ensureCharacterExists, getCharacter } from './characters'
import { ensurePersonaExists, getPersona, resolvePersonaForChat } from './personas'
import { recordTombstone } from './tombstones'
import { normalizeSavedMessages, type ChatSaveInput } from '@shared/chat-schema'
import { DEFAULT_CONTEXT_WINDOW_SIZE } from '@shared/chat-settings'
import { deriveChatTitle, renderCharacterTemplate } from '@shared/prompt-builder'
import type { Chat, ChatSummary, ChatWithMessages, Message } from '@shared/types'

const resolveLastMessageAt = async (chat: Chat): Promise<number | undefined> => {
  if (chat.lastMessageAt !== undefined) return chat.lastMessageAt

  const messages = await getAllByIndex<Message>('messages', 'byChatId', chat.id)
  if (messages.length === 0) return undefined

  return Math.max(...messages.map((message) => message.createdAt))
}

export const listChats = async (): Promise<ChatSummary[]> => {
  const chats = await getAll<Chat>('chats')
  const summaries: ChatSummary[] = []

  for (const chat of chats) {
    const character = await getCharacter(chat.characterId)
    const persona = chat.personaId ? await getPersona(chat.personaId) : await resolvePersonaForChat()
    const lastMessageAt = await resolveLastMessageAt(chat)
    summaries.push({
      ...chat,
      ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
      characterName: character?.name,
      personaName: persona?.name
    })
  }

  return summaries.sort(
    (a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)
  )
}

export const getChat = async (id: string): Promise<ChatWithMessages | null> => {
  const chat = await get<Chat>('chats', id)
  if (!chat) return null

  const messages = await getMessages(id)
  const character = (await getCharacter(chat.characterId)) ?? undefined
  const persona = (await resolvePersonaForChat(chat.personaId)) ?? undefined
  return { ...chat, messages, character, persona }
}

export const createChat = async (
  characterId: string,
  personaId?: string,
  title = 'New chat'
): Promise<ChatWithMessages> => {
  const character = await ensureCharacterExists(characterId)
  const persona = await resolvePersonaForChat(personaId)
  const now = Date.now()
  const chatTitle = character.name ? `Chat with ${character.name}` : title
  const chat: Chat = {
    id: crypto.randomUUID(),
    characterId,
    ...(persona ? { personaId: persona.id } : {}),
    title: chatTitle,
    contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
    modelId: null,
    provider: null,
    createdAt: now,
    updatedAt: now
  }
  await put('chats', chat)

  const greeting = character.greeting?.trim()
  if (greeting) {
    const renderedGreeting = renderCharacterTemplate(greeting, character, persona ?? undefined)
    await addMessage(chat.id, 'assistant', renderedGreeting)
    await renameChat(chat.id, deriveChatTitle(renderedGreeting))
  }

  const created = await getChat(chat.id)
  if (!created) throw new Error('Failed to create chat')
  return created
}

export const deleteChat = async (id: string): Promise<void> => {
  await recordTombstone('chats', id)
  await deleteMessagesForChat(id)
  await deleteByKey('chats', id)
}

/**
 * Write a chat received from sync, preserving its id, `createdAt` and remote
 * `updatedAt`. Unlike `saveChat` it does NOT verify the character/persona exist
 * (a referenced entity may arrive later in the same sync batch) and writes
 * silently. `lastMessageAt` is recomputed from the incoming messages.
 */
export const applySyncedChat = async (save: ChatSaveInput, updatedAt: number): Promise<void> => {
  const messages = normalizeSavedMessages(save.messages, save.id)

  await deleteMessagesForChat(save.id, { silent: true })
  for (const message of messages) {
    await putSilent('messages', message)
  }

  const lastMessageAt =
    messages.length > 0 ? Math.max(...messages.map((message) => message.createdAt)) : undefined
  const chat: Chat = {
    id: save.id,
    characterId: save.characterId,
    ...(save.personaId ? { personaId: save.personaId } : {}),
    title: save.title,
    modelId: save.modelId,
    provider: save.provider,
    createdAt: save.createdAt,
    updatedAt,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(save.systemPrompt !== undefined ? { systemPrompt: save.systemPrompt } : {}),
    ...(save.temperature !== undefined ? { temperature: save.temperature } : {}),
    ...(save.topP !== undefined ? { topP: save.topP } : {}),
    ...(save.maxTokens !== undefined ? { maxTokens: save.maxTokens } : {}),
    ...(save.contextWindowSize !== undefined ? { contextWindowSize: save.contextWindowSize } : {}),
    ...(save.keepAliveMinutes !== undefined ? { keepAliveMinutes: save.keepAliveMinutes } : {})
  }
  await putSilent('chats', chat)
}

/** Apply a remote chat deletion: drop the chat and its messages. */
export const applyChatTombstone = async (id: string): Promise<void> => {
  await deleteMessagesForChat(id, { silent: true })
  await deleteByKeySilent('chats', id)
}

export const renameChat = async (id: string, title: string): Promise<void> => {
  const chat = await get<Chat>('chats', id)
  if (!chat) throw new Error('Chat not found')
  await put('chats', { ...chat, title, updatedAt: Date.now() })
}

export const setChatModel = async (id: string, modelId: string, provider: 'ollama'): Promise<void> => {
  const chat = await get<Chat>('chats', id)
  if (!chat) throw new Error('Chat not found')
  await put('chats', { ...chat, modelId, provider, updatedAt: Date.now() })
}

export const saveChatSettings = async (
  id: string,
  settings: {
    personaId?: string
    systemPrompt?: string
    temperature?: number
    topP?: number
    maxTokens?: number
    contextWindowSize?: number
    keepAliveMinutes?: number
  }
): Promise<ChatWithMessages> => {
  const chat = await get<Chat>('chats', id)
  if (!chat) throw new Error('Chat not found')

  const updated: Chat = { ...chat, updatedAt: Date.now() }

  if ('personaId' in settings) {
    if (settings.personaId) {
      const persona = await ensurePersonaExists(settings.personaId)
      updated.personaId = persona.id
    } else {
      delete updated.personaId
    }
  }

  if ('systemPrompt' in settings) {
    const trimmed = settings.systemPrompt?.trim()
    if (trimmed) updated.systemPrompt = trimmed
    else delete updated.systemPrompt
  }

  if ('temperature' in settings) {
    if (settings.temperature !== undefined) updated.temperature = settings.temperature
    else delete updated.temperature
  }

  if ('topP' in settings) {
    if (settings.topP !== undefined) updated.topP = settings.topP
    else delete updated.topP
  }

  if ('maxTokens' in settings) {
    if (settings.maxTokens !== undefined) updated.maxTokens = settings.maxTokens
    else delete updated.maxTokens
  }

  if ('contextWindowSize' in settings) {
    if (settings.contextWindowSize !== undefined) {
      updated.contextWindowSize = settings.contextWindowSize
    } else {
      delete updated.contextWindowSize
    }
  }

  if ('keepAliveMinutes' in settings) {
    if (settings.keepAliveMinutes !== undefined) {
      updated.keepAliveMinutes = settings.keepAliveMinutes
    } else {
      delete updated.keepAliveMinutes
    }
  }

  await put('chats', updated)

  const saved = await getChat(id)
  if (!saved) throw new Error('Failed to save chat settings')
  return saved
}

const touchChat = async (id: string, at: number = Date.now()): Promise<void> => {
  const chat = await get<Chat>('chats', id)
  if (!chat) return
  await put('chats', { ...chat, updatedAt: at, lastMessageAt: at })
}

export const getMessage = async (messageId: string): Promise<Message | null> => {
  return (await get<Message>('messages', messageId)) ?? null
}

export const addMessage = async (
  chatId: string,
  role: Message['role'],
  content: string,
  options: { truncated?: boolean } = {}
): Promise<Message> => {
  const message: Message = {
    id: crypto.randomUUID(),
    chatId,
    role,
    content,
    variations: role === 'assistant' ? [content] : undefined,
    activeVariationIndex: 0,
    createdAt: Date.now(),
    truncated: options.truncated ? true : undefined
  }
  await put('messages', message)
  await touchChat(chatId, message.createdAt)
  return message
}

export const addMessageVariation = async (
  messageId: string,
  content: string,
  options: { truncated?: boolean } = {}
): Promise<Message> => {
  const existing = await getMessage(messageId)
  if (!existing) throw new Error('Message not found')
  if (existing.role !== 'assistant') throw new Error('Only assistant messages support variations')

  const variations = [...(existing.variations ?? [existing.content]), content]
  const activeVariationIndex = variations.length - 1
  const updated: Message = {
    ...existing,
    variations,
    activeVariationIndex,
    content,
    truncated: options.truncated ? true : undefined
  }
  await put('messages', updated)
  await touchChat(existing.chatId)
  return updated
}

export const setActiveVariation = async (messageId: string, index: number): Promise<Message> => {
  const existing = await getMessage(messageId)
  if (!existing) throw new Error('Message not found')

  const variations = existing.variations ?? [existing.content]
  if (index < 0 || index >= variations.length) {
    throw new Error('Variation index out of range')
  }

  const updated: Message = {
    ...existing,
    activeVariationIndex: index,
    content: variations[index]
  }
  await put('messages', updated)
  await touchChat(existing.chatId)
  return updated
}

export const getMessages = async (chatId: string): Promise<Message[]> => {
  const messages = await getAllByIndex<Message>('messages', 'byChatId', chatId)
  return messages.sort((a, b) => a.createdAt - b.createdAt)
}

export const deleteMessage = async (messageId: string): Promise<void> => {
  await deleteByKey('messages', messageId)
}

export const deleteChatMessage = async (chatId: string, messageId: string): Promise<void> => {
  const message = await getMessage(messageId)
  if (!message) throw new Error('Message not found')
  if (message.chatId !== chatId) throw new Error('Message does not belong to this chat')

  await deleteMessage(messageId)
  await touchChat(chatId)
}

export const updateMessageContent = async (messageId: string, content: string): Promise<Message> => {
  const existing = await getMessage(messageId)
  if (!existing) throw new Error('Message not found')
  if (existing.role !== 'user') throw new Error('Only user messages can be edited')

  const updated = { ...existing, content }
  await put('messages', updated)
  await touchChat(existing.chatId)
  return updated
}

export const updateAssistantMessageContent = async (
  messageId: string,
  content: string
): Promise<Message> => {
  const existing = await getMessage(messageId)
  if (!existing) throw new Error('Message not found')
  if (existing.role !== 'assistant') throw new Error('Only assistant messages can be edited')

  const variations = [...(existing.variations ?? [existing.content])]
  const activeIndex = existing.activeVariationIndex ?? 0
  if (activeIndex < 0 || activeIndex >= variations.length) {
    throw new Error('Variation index out of range')
  }
  variations[activeIndex] = content

  const updated: Message = { ...existing, variations, content }
  await put('messages', updated)
  await touchChat(existing.chatId)
  return updated
}

export const deleteMessagesAfter = async (chatId: string, messageId: string): Promise<void> => {
  const messages = await getMessages(chatId)
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) throw new Error('Message not found')

  for (let i = messages.length - 1; i > index; i -= 1) {
    await deleteMessage(messages[i].id)
  }
}

export const listChatsForCharacter = async (characterId: string): Promise<Chat[]> => {
  return getAllByIndex<Chat>('chats', 'byCharacterId', characterId)
}

export const listChatsForPersona = async (personaId: string): Promise<Chat[]> => {
  return getAllByIndex<Chat>('chats', 'byPersonaId', personaId)
}

export const saveChat = async (data: {
  id: string
  characterId: string
  personaId?: string
  title: string
  modelId: string | null
  provider: 'ollama' | null
  createdAt: number
  systemPrompt?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  contextWindowSize?: number
  keepAliveMinutes?: number
  messages: Message[]
}): Promise<ChatWithMessages> => {
  const existing = await get<Chat>('chats', data.id)
  if (!existing) throw new Error('Chat not found')

  await ensureCharacterExists(data.characterId)
  const persona = await resolvePersonaForChat(data.personaId)

  await deleteMessagesForChat(data.id)

  for (const message of data.messages) {
    await put('messages', message)
  }

  const now = Date.now()
  const lastMessageAt =
    data.messages.length > 0 ? Math.max(...data.messages.map((message) => message.createdAt)) : undefined
  const chat: Chat = {
    id: data.id,
    characterId: data.characterId,
    ...(persona ? { personaId: persona.id } : {}),
    title: data.title,
    modelId: data.modelId,
    provider: data.provider,
    createdAt: data.createdAt,
    updatedAt: now,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
    ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
    ...(data.topP !== undefined ? { topP: data.topP } : {}),
    ...(data.maxTokens !== undefined ? { maxTokens: data.maxTokens } : {}),
    ...(data.contextWindowSize !== undefined ? { contextWindowSize: data.contextWindowSize } : {}),
    ...(data.keepAliveMinutes !== undefined ? { keepAliveMinutes: data.keepAliveMinutes } : {})
  }
  await put('chats', chat)

  const saved = await getChat(data.id)
  if (!saved) throw new Error('Failed to save chat')
  return saved
}

export const importChat = async (data: {
  id: string
  characterId: string
  personaId?: string
  title: string
  modelId: string | null
  provider: 'ollama' | null
  createdAt: number
  systemPrompt?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  contextWindowSize?: number
  keepAliveMinutes?: number
  messages: Message[]
}): Promise<ChatWithMessages> => {
  await ensureCharacterExists(data.characterId)
  const persona = await resolvePersonaForChat(data.personaId)

  const now = Date.now()
  const lastMessageAt =
    data.messages.length > 0 ? Math.max(...data.messages.map((message) => message.createdAt)) : undefined
  const chat: Chat = {
    id: data.id,
    characterId: data.characterId,
    ...(persona ? { personaId: persona.id } : {}),
    title: data.title,
    modelId: data.modelId,
    provider: data.provider,
    createdAt: data.createdAt,
    updatedAt: now,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
    ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
    ...(data.topP !== undefined ? { topP: data.topP } : {}),
    ...(data.maxTokens !== undefined ? { maxTokens: data.maxTokens } : {}),
    ...(data.contextWindowSize !== undefined ? { contextWindowSize: data.contextWindowSize } : {}),
    ...(data.keepAliveMinutes !== undefined ? { keepAliveMinutes: data.keepAliveMinutes } : {})
  }

  await put('chats', chat)

  for (const message of data.messages) {
    await put('messages', message)
  }

  const imported = await getChat(data.id)
  if (!imported) throw new Error('Failed to import chat')
  return imported
}
