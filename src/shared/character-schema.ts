import { z } from 'zod'

export const characterPersonalitySchema = z.object({
  traits: z.array(z.string()).optional(),
  speakingStyle: z.string().optional()
})

export const characterDefaultParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional()
})

const legacyExampleMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string()
})

const characterSchemaBase = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  avatar: z.string().optional(),
  description: z.string().optional(),
  /** @deprecated Legacy field — merged into description on import */
  systemPrompt: z.string().optional(),
  personality: characterPersonalitySchema.optional(),
  scenario: z.string().optional(),
  greeting: z.string().optional(),
  /** @deprecated Legacy field — first assistant message becomes greeting */
  exampleMessages: z.array(legacyExampleMessageSchema).optional(),
  defaultParams: characterDefaultParamsSchema.optional()
})

export const characterSchema = characterSchemaBase.transform(
  ({ systemPrompt, exampleMessages, greeting, ...character }) => {
    let next = { ...character, greeting }

    if (systemPrompt && !next.description) {
      next.description = systemPrompt
    } else if (systemPrompt && next.description && !next.description.includes(systemPrompt)) {
      next.description = `${next.description}\n\n${systemPrompt}`
    }

    if (!next.greeting && exampleMessages?.length) {
      const assistantMessage = exampleMessages.find((message) => message.role === 'assistant')
      if (assistantMessage?.content.trim()) {
        next.greeting = assistantMessage.content.trim()
      }
    }

    return next
  }
)

export type CharacterInput = Omit<z.infer<typeof characterSchema>, 'id'> & { id: string }

export const parseCharacter = (data: unknown): CharacterInput => {
  const parsed = characterSchema.parse(data)
  return { ...parsed, id: parsed.id ?? crypto.randomUUID() }
}

export const safeParseCharacter = (data: unknown) => {
  return characterSchema.safeParse(data)
}
