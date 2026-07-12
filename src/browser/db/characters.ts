import { get, getAll, put, deleteByKey, getAllByIndex, deleteMessagesForChat } from './index'
import { parseCharacter, safeParseCharacter } from '@shared/character-schema'
import type { Character, CharacterSummary } from '@shared/types'

type StoredCharacter = Character & { updatedAt: number }

const toSummary = (stored: StoredCharacter): CharacterSummary => {
  return {
    id: stored.id,
    name: stored.name,
    avatar: stored.avatar,
    description: stored.description,
    updatedAt: stored.updatedAt
  }
}

export const listCharacters = async (): Promise<CharacterSummary[]> => {
  const all = await getAll<StoredCharacter>('characters')
  return all.sort((a, b) => a.name.localeCompare(b.name)).map(toSummary)
}

export const getCharacter = async (id: string): Promise<Character | null> => {
  const stored = await get<StoredCharacter>('characters', id)
  if (!stored) return null
  const { updatedAt: _, ...character } = stored
  return character
}

export const ensureCharacterExists = async (id: string): Promise<Character> => {
  const character = await getCharacter(id)
  if (!character) throw new Error('Character not found')
  return character
}

export const saveCharacter = async (character: Character): Promise<Character> => {
  const parsed = parseCharacter(character)
  const stored: StoredCharacter = { ...parsed, updatedAt: Date.now() }
  await put('characters', stored)
  return parsed
}

export const deleteCharacter = async (id: string): Promise<void> => {
  const chats = await getAllByIndex<{ id: string }>('chats', 'byCharacterId', id)
  for (const chat of chats) {
    await deleteMessagesForChat(chat.id)
    await deleteByKey('chats', chat.id)
  }
  await deleteByKey('characters', id)
}

const pickCharacterJson = (): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        const text = await file.text()
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export const importCharacter = async (): Promise<Character | null> => {
  const raw = await pickCharacterJson()
  if (raw === null) return null

  const parsed = safeParseCharacter(raw)
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(', '))
  }

  const character: Character = { ...parsed.data, id: crypto.randomUUID() }
  return saveCharacter(character)
}

export const exportCharacter = async (id: string): Promise<boolean> => {
  const character = await getCharacter(id)
  if (!character) return false

  const blob = new Blob([JSON.stringify(character, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${character.name.replace(/[^a-z0-9-_]/gi, '_')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  return true
}
