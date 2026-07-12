import { get, getAll, put, deleteByKey, getAllByIndex } from './index'
import { parsePersona, safeParsePersona } from '@shared/persona-schema'
import type { Chat, Persona, PersonaSummary } from '@shared/types'

type StoredPersona = Persona & { updatedAt: number }

const DEFAULT_PERSONA: Persona = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Sam',
  description: ''
}

const toSummary = (stored: StoredPersona): PersonaSummary => {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    updatedAt: stored.updatedAt
  }
}

const getStoredPersonas = async (): Promise<StoredPersona[]> => {
  return getAll<StoredPersona>('personas')
}

export const ensureDefaultPersona = async (): Promise<Persona> => {
  const all = await getStoredPersonas()
  if (all.length > 0) {
    const { updatedAt: _, ...persona } = all[0]
    return persona
  }

  const stored: StoredPersona = { ...DEFAULT_PERSONA, updatedAt: Date.now() }
  await put('personas', stored)
  return DEFAULT_PERSONA
}

export const listPersonas = async (): Promise<PersonaSummary[]> => {
  await ensureDefaultPersona()
  const all = await getStoredPersonas()
  return all.sort((a, b) => a.name.localeCompare(b.name)).map(toSummary)
}

export const getPersona = async (id: string): Promise<Persona | null> => {
  const stored = await get<StoredPersona>('personas', id)
  if (!stored) return null
  const { updatedAt: _, ...persona } = stored
  return persona
}

export const ensurePersonaExists = async (id: string): Promise<Persona> => {
  const persona = await getPersona(id)
  if (!persona) throw new Error('Persona not found')
  return persona
}

export const resolvePersonaForChat = async (personaId?: string): Promise<Persona | null> => {
  if (personaId) return ensurePersonaExists(personaId)

  const personas = await listPersonas()
  if (personas.length !== 1) return null
  return ensurePersonaExists(personas[0].id)
}

export const savePersona = async (persona: Persona): Promise<Persona> => {
  const parsed = parsePersona(persona)
  const description = parsed.description?.trim()
  const stored: StoredPersona = {
    ...parsed,
    ...(description ? { description } : { description: '' }),
    updatedAt: Date.now()
  }
  await put('personas', stored)
  return parsed
}

export const deletePersona = async (id: string): Promise<void> => {
  const all = await listPersonas()
  if (all.length <= 1) throw new Error('At least one persona is required')

  const replacement = all.find((persona) => persona.id !== id)
  if (!replacement) throw new Error('Replacement persona not found')

  const chats = await getAllByIndex<Chat>('chats', 'byPersonaId', id)
  for (const chat of chats) {
    await put('chats', { ...chat, personaId: replacement.id, updatedAt: Date.now() })
  }

  await deleteByKey('personas', id)
}

const pickPersonaJson = (): Promise<unknown> => {
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

export const importPersona = async (): Promise<Persona | null> => {
  const raw = await pickPersonaJson()
  if (raw === null) return null

  const parsed = safeParsePersona(raw)
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(', '))
  }

  const persona: Persona = { ...parsed.data, id: crypto.randomUUID() }
  return savePersona(persona)
}

export const exportPersona = async (id: string): Promise<boolean> => {
  const persona = await getPersona(id)
  if (!persona) return false

  const blob = new Blob([JSON.stringify(persona, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${persona.name.replace(/[^a-z0-9-_]/gi, '_')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  return true
}
