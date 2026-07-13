import {
  extractCharacterCardJsonFromPng,
  isPngBuffer,
  pngBufferToDataUrl
} from './png-character-card'
import { stripHtml } from './strip-html'

type RecordLike = Record<string, unknown>

const isRecord = (value: unknown): value is RecordLike =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asCleanString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const cleaned = stripHtml(value)
  return cleaned.length > 0 ? cleaned : undefined
}

const sanitizeImportedCharacter = (raw: RecordLike): RecordLike => {
  const next: RecordLike = { ...raw }

  if (typeof next.name === 'string') next.name = stripHtml(next.name)
  if (typeof next.description === 'string') next.description = stripHtml(next.description)
  if (typeof next.scenario === 'string') next.scenario = stripHtml(next.scenario)
  if (typeof next.greeting === 'string') next.greeting = stripHtml(next.greeting)
  if (typeof next.systemPrompt === 'string') next.systemPrompt = stripHtml(next.systemPrompt)

  if (Array.isArray(next.exampleMessages)) {
    next.exampleMessages = next.exampleMessages.map((message) => {
      if (!isRecord(message) || typeof message.content !== 'string') return message
      return { ...message, content: stripHtml(message.content) }
    })
  }

  if (isRecord(next.personality)) {
    const personality = { ...next.personality }
    if (typeof personality.speakingStyle === 'string') {
      personality.speakingStyle = stripHtml(personality.speakingStyle)
    }
    if (Array.isArray(personality.traits)) {
      personality.traits = personality.traits.map((trait) =>
        typeof trait === 'string' ? stripHtml(trait) : trait
      )
    }
    next.personality = personality
  }

  return next
}

export const isTavernCharacterCard = (raw: unknown): boolean => {
  if (!isRecord(raw)) return false

  if (typeof raw.spec === 'string' && raw.spec.startsWith('chara_card_')) {
    return true
  }

  if ('first_mes' in raw) return true

  if (isRecord(raw.data) && 'first_mes' in raw.data) return true
  if (isRecord(raw.card)) return isTavernCharacterCard(raw.card)
  if (isRecord(raw.character)) return isTavernCharacterCard(raw.character)

  return false
}

const unwrapTavernCard = (raw: unknown): RecordLike | null => {
  if (!isRecord(raw)) return null

  if (isRecord(raw.card)) {
    return unwrapTavernCard(raw.card)
  }

  if (isRecord(raw.character)) {
    return unwrapTavernCard(raw.character)
  }

  if (isRecord(raw.data) && typeof raw.spec === 'string') {
    return raw.data
  }

  if (typeof raw.name === 'string') {
    return raw
  }

  return null
}

const joinSections = (sections: Array<string | undefined>): string | undefined => {
  const parts = sections.filter((section): section is string => Boolean(section))
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export const convertTavernCardToOpenChar = (
  raw: unknown,
  avatar?: string
): RecordLike => {
  const data = unwrapTavernCard(raw)
  if (!data) {
    throw new Error('Unrecognized Tavern character card format')
  }

  const name = asCleanString(data.name)
  if (!name) {
    throw new Error('Character card is missing a name')
  }

  const personalityText = asCleanString(data.personality)

  return sanitizeImportedCharacter({
    name,
    ...(avatar ? { avatar } : {}),
    description: joinSections([
      asCleanString(data.description),
      asCleanString(data.system_prompt),
      asCleanString(data.mes_example),
      asCleanString(data.post_history_instructions),
      asCleanString(data.creator_notes)
    ]),
    ...(personalityText ? { personality: { speakingStyle: personalityText } } : {}),
    scenario: asCleanString(data.scenario),
    greeting: asCleanString(data.first_mes)
  })
}

export const normalizeCharacterImportData = (
  raw: unknown,
  avatar?: string
): unknown => {
  if (isTavernCharacterCard(raw)) {
    return convertTavernCardToOpenChar(raw, avatar)
  }

  if (!isRecord(raw)) return raw

  const withAvatar = avatar && !raw.avatar ? { ...raw, avatar } : raw
  return sanitizeImportedCharacter(withAvatar)
}

export const parseCharacterImportFile = async (
  file: File
): Promise<{ raw: unknown; avatar?: string }> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lowerName = file.name.toLowerCase()

  if (isPngBuffer(bytes) || lowerName.endsWith('.png')) {
    if (!isPngBuffer(bytes)) {
      throw new Error('File is not a valid PNG image')
    }

    const raw = await extractCharacterCardJsonFromPng(bytes)
    return {
      raw,
      avatar: pngBufferToDataUrl(bytes)
    }
  }

  if (
    lowerName.endsWith('.json') ||
    file.type === 'application/json' ||
    file.type === 'text/json'
  ) {
    const text = new TextDecoder('utf-8').decode(bytes)
    return { raw: JSON.parse(text) as unknown }
  }

  throw new Error('Unsupported file type. Import a JSON or PNG character card.')
}
