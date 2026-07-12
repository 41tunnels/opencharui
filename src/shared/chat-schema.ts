import { z } from 'zod'
import type { ChatWithMessages, Message } from './types'

const messageSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().uuid(),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  variations: z.array(z.string()).optional(),
  activeVariationIndex: z.number().int().nonnegative().optional(),
  createdAt: z.number()
})

const chatGenerationSettingsSchema = z.object({
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  contextWindowSize: z.number().int().min(4).max(100).optional()
})

export const chatSaveSchema = z
  .object({
    id: z.string().uuid(),
    characterId: z.string().uuid(),
    personaId: z.string().uuid().optional(),
    title: z.string().min(1),
    modelId: z.string().nullable(),
    provider: z.enum(['ollama']).nullable(),
    createdAt: z.number(),
    updatedAt: z.number().optional(),
    messages: z.array(messageSchema)
  })
  .merge(chatGenerationSettingsSchema)
  .superRefine((chat, ctx) => {
    for (const [index, message] of chat.messages.entries()) {
      if (message.chatId !== chat.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messages[${index}].chatId must match chat id`,
          path: ['messages', index, 'chatId']
        })
      }

      if (message.role === 'assistant') {
        const variations = message.variations ?? [message.content]
        const activeIndex = message.activeVariationIndex ?? 0
        if (activeIndex >= variations.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `messages[${index}].activeVariationIndex out of range`,
            path: ['messages', index, 'activeVariationIndex']
          })
        }
      }
    }
  })

export type ChatSaveInput = z.infer<typeof chatSaveSchema>

export const parseChatSave = (data: unknown): ChatSaveInput => {
  return chatSaveSchema.parse(data)
}

export const safeParseChatSave = (data: unknown) => {
  return chatSaveSchema.safeParse(data)
}

export const chatToJson = (chat: ChatWithMessages): ChatSaveInput => {
  const { character: _, persona: _persona, ...rest } = chat
  return {
    ...rest,
    messages: rest.messages.map((message) => normalizeMessageForSave(message))
  }
}

const normalizeMessageForSave = (message: Message): Message => {
  if (message.role === 'assistant') {
    const variations = message.variations ?? [message.content]
    const activeVariationIndex = message.activeVariationIndex ?? 0
    return {
      ...message,
      variations,
      activeVariationIndex,
      content: variations[activeVariationIndex] ?? message.content
    }
  }
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }
}

export const normalizeSavedMessages = (messages: Message[], chatId: string): Message[] => {
  return messages.map((message) => {
    const withChatId = { ...message, chatId }
    if (withChatId.role === 'assistant') {
      const variations = withChatId.variations ?? [withChatId.content]
      const activeVariationIndex = withChatId.activeVariationIndex ?? 0
      return {
        ...withChatId,
        variations,
        activeVariationIndex,
        content: variations[activeVariationIndex] ?? withChatId.content
      }
    }
    return {
      id: withChatId.id,
      chatId: withChatId.chatId,
      role: withChatId.role,
      content: withChatId.content,
      createdAt: withChatId.createdAt
    }
  })
}

/** Assign fresh ids for importing a chat JSON export. */
export const prepareChatImport = (data: ChatSaveInput): ChatSaveInput => {
  const chatId = crypto.randomUUID()
  return {
    ...data,
    id: chatId,
    messages: data.messages.map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      chatId
    }))
  }
}
