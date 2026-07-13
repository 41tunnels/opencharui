import type { Character, Message, Persona } from './types'

const HISTORY_WINDOW = 20
const DEFAULT_USER_NAME = 'Sam'

export const renderCharacterTemplate = (
  content: string,
  character: Character,
  persona?: Persona
): string => {
  return content
    .replaceAll('{{char}}', character.name)
    .replaceAll('{{user}}', persona?.name ?? DEFAULT_USER_NAME)
}

const renderPromptTemplate = (content: string, character: Character, persona?: Persona): string => {
  return renderCharacterTemplate(content, character, persona)
}

const buildCharacterContext = (character: Character): string[] => {
  return [
    `Character name: ${character.name}`,
    character.description ? `Character: ${character.description}` : null,
    character.scenario ? `Scenario: ${character.scenario}` : null,
    character.personality ? `Personality: ${JSON.stringify(character.personality)}` : null
  ].filter(Boolean) as string[]
}

const buildCharacterSystemPrompt = (character: Character): string => {
  return buildCharacterContext(character).join('\n\n')
}

const buildPersonaContext = (persona?: Persona): string[] => {
  if (!persona) return []
  return [
    `User name: ${persona.name}`,
    persona.description ? `User: ${persona.description}` : null
  ].filter(Boolean) as string[]
}

const buildPersonaSystemPrompt = (persona?: Persona): string => {
  return buildPersonaContext(persona).join('\n\n')
}

export const buildSystemContent = (
  systemPrompt: string,
  character: Character,
  persona?: Persona,
  extraParts: Array<string | null | undefined> = []
): string => {
  const mainSystemPrompt = systemPrompt.trim()
  const characterSystemPrompt = buildCharacterSystemPrompt(character)
  const personaSystemPrompt = buildPersonaSystemPrompt(persona)
  const promptWithContext = [mainSystemPrompt, characterSystemPrompt, personaSystemPrompt]
    .filter(Boolean)
    .join('\n\n')

  const parts = [promptWithContext, ...extraParts]
    .filter((part): part is string => Boolean(part))
    .map((part) => renderPromptTemplate(part, character, persona))
  return parts.join('\n\n')
}

export const buildMessages = (
  systemPrompt: string,
  character: Character,
  persona: Persona | undefined,
  chatHistory: Message[],
  userInput: string,
  historyWindow = HISTORY_WINDOW
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => {
  const system = buildSystemContent(systemPrompt, character, persona)
  const history = chatHistory
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-historyWindow)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  return [...(system ? [{ role: 'system' as const, content: system }] : []), ...history, { role: 'user' as const, content: userInput }]
}

export const buildOpeningMessages = (
  systemPrompt: string,
  character: Character,
  persona?: Persona
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => {
  const greeting = character.greeting?.trim()
  const renderedGreeting = greeting
    ? renderCharacterTemplate(greeting, character, persona)
    : null
  const openingGuidance = renderedGreeting
    ? `Scene direction for your opening (match the tone and situation, but write fresh dialogue — do not repeat these lines verbatim):\n${renderedGreeting}`
    : null

  return [
    {
      role: 'system',
      content: buildSystemContent(systemPrompt, character, persona, [openingGuidance])
    },
    {
      role: 'user',
      content: OPENING_USER_PROMPT
    }
  ]
}

export const deriveChatTitle = (firstMessage: string): string => {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 48) return trimmed
  return `${trimmed.slice(0, 45)}...`
}

export const DEFAULT_SYSTEM_PROMPT = `Stay in character at all times. Never mention being an AI or language model. Respond naturally and in first person as the character you are portraying.

{{char}} means the character and is replaced by the character name
{{user}} means the user and is replaced by the users name

Writing something in uppercase means screaming or yelling
Writing in lowercase means normal speaking

Everything between two * are thoughts and feelings
Everything between two " means quoting
Everything else is normal spoken word`

export const OPENING_USER_PROMPT =
  'Start the roleplay now. Write your opening message in character. Do not mention being an AI or language model.'
