import { get, getAll, put } from './index'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/prompt-builder'

const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  ollamaUrl: '',
  ollamaApiKey: ''
}

type SettingRow = { key: string; value: string }

export const getSettings = async (): Promise<AppSettings> => {
  const rows = await getAll<SettingRow>('settings')
  const settings: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value)
      if (row.key === 'systemPrompt') settings.systemPrompt = parsed
      if (row.key === 'ollamaUrl') settings.ollamaUrl = parsed
      if (row.key === 'ollamaApiKey') settings.ollamaApiKey = parsed
    } catch {
      // ignore invalid rows
    }
  }
  return settings
}

export const saveSettings = async (partial: Partial<AppSettings>): Promise<AppSettings> => {
  const current = await getSettings()
  const next = { ...current, ...partial }

  if (partial.systemPrompt !== undefined) {
    await put('settings', { key: 'systemPrompt', value: JSON.stringify(next.systemPrompt) })
  }

  if (partial.ollamaUrl !== undefined) {
    await put('settings', { key: 'ollamaUrl', value: JSON.stringify(next.ollamaUrl) })
  }

  if (partial.ollamaApiKey !== undefined) {
    await put('settings', { key: 'ollamaApiKey', value: JSON.stringify(next.ollamaApiKey) })
  }

  return next
}

export const getSettingRow = async (key: string): Promise<SettingRow | undefined> => {
  return get<SettingRow>('settings', key)
}
