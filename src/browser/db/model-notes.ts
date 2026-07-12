import { get, putSilent } from './index'
import type { ModelNotes } from '@shared/types'

const MODEL_NOTES_KEY = 'modelNotes'

type ModelNotesRow = { key: string; value: string }

export const getModelNotes = async (): Promise<ModelNotes> => {
  const row = await get<ModelNotesRow>('settings', MODEL_NOTES_KEY)
  if (!row?.value) return {}

  try {
    const parsed = JSON.parse(row.value) as ModelNotes
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // ignore invalid rows
  }

  return {}
}

const saveModelNotes = async (notes: ModelNotes): Promise<void> => {
  await putSilent('settings', { key: MODEL_NOTES_KEY, value: JSON.stringify(notes) })
}

export const setModelNote = async (modelId: string, note: string): Promise<void> => {
  const notes = await getModelNotes()
  if (note.trim()) {
    notes[modelId] = note
  } else {
    delete notes[modelId]
  }
  await saveModelNotes(notes)
}

export const deleteModelNote = async (modelId: string): Promise<void> => {
  const notes = await getModelNotes()
  if (!(modelId in notes)) return
  delete notes[modelId]
  await saveModelNotes(notes)
}
