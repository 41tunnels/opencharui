import { get, getAll, put } from './index'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/prompt-builder'

const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  ollamaUrl: '',
  ollamaApiKey: '',
  activePairingId: ''
}

// A key list rather than one hardcoded `if` per field in both
// getSettings and saveSettings — the previous shape needed a matching
// pair of checks added by hand for every new setting, which is exactly
// the kind of place a new field (activePairingId) is easy to add to one
// function and forget in the other.
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

type SettingRow = { key: string; value: string }

export const getSettings = async (): Promise<AppSettings> => {
  const rows = await getAll<SettingRow>('settings')
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  const settings: AppSettings = { ...DEFAULT_SETTINGS }

  for (const key of SETTINGS_KEYS) {
    const raw = byKey.get(key)
    if (raw === undefined) continue
    try {
      settings[key] = JSON.parse(raw)
    } catch {
      // ignore invalid rows
    }
  }
  return settings
}

export const saveSettings = async (partial: Partial<AppSettings>): Promise<AppSettings> => {
  const current = await getSettings()
  const next = { ...current, ...partial }

  for (const key of SETTINGS_KEYS) {
    if (partial[key] !== undefined) {
      await put('settings', { key, value: JSON.stringify(next[key]) })
    }
  }

  return next
}

export const getSettingRow = async (key: string): Promise<SettingRow | undefined> => {
  return get<SettingRow>('settings', key)
}
