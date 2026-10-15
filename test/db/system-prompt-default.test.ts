// A stored system prompt that exactly matches an earlier default was never
// edited — Settings just saves every field — so it must follow the current
// default. Customised prompts are left alone, and saving the stock prompt
// removes the stored copy so the next default change reaches the user too.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { putSilent } from '@browser/db/index'
import { getSettingRow, getSettings, saveSettings } from '@browser/db/settings'
import { DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_SYSTEM_PROMPTS } from '@shared/prompt-builder'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

const storePrompt = (value: string) =>
  putSilent('settings', { key: 'systemPrompt', value: JSON.stringify(value) })

describe('default system prompt migration', () => {
  it('upgrades a stored legacy default to the current one', async () => {
    await storePrompt(LEGACY_DEFAULT_SYSTEM_PROMPTS[0]!)
    expect((await getSettings()).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
  })

  it('leaves a customised prompt untouched', async () => {
    const custom = `${LEGACY_DEFAULT_SYSTEM_PROMPTS[0]!}\nAlways reply in German`
    await storePrompt(custom)
    expect((await getSettings()).systemPrompt).toBe(custom)
  })

  it('does not store the stock prompt on save', async () => {
    await storePrompt('something custom')

    const saved = await saveSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT })
    expect(saved.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(await getSettingRow('systemPrompt')).toBeUndefined()

    await saveSettings({ systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPTS[0]! })
    expect(await getSettingRow('systemPrompt')).toBeUndefined()
  })

  it('still stores a customised prompt on save', async () => {
    await saveSettings({ systemPrompt: 'custom' })
    const row = await getSettingRow('systemPrompt')
    expect(row && JSON.parse(row.value)).toBe('custom')
  })
})
