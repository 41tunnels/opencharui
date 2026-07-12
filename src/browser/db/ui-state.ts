import { get, putSilent } from './index'
import type { AppUiState, AppTheme } from '@shared/types'
import { DEFAULT_UI_STATE } from '@shared/types'
import { readCachedTheme, readThemeFromDocument } from '@shared/theme'
const UI_STATE_KEY = 'uiState'

type UiStateRow = { key: string; value: string }

const resolveTheme = (parsed: Partial<AppUiState>): AppTheme => {
  if (parsed.theme === 'light' || parsed.theme === 'dark') return parsed.theme
  return readCachedTheme() ?? readThemeFromDocument() ?? DEFAULT_UI_STATE.theme
}
const mergeUiState = (partial: Partial<AppUiState>, current: AppUiState): AppUiState => {
  return {
    sidebarCollapsed: partial.sidebarCollapsed ?? current.sidebarCollapsed,
    sidebarSections: {
      characters: partial.sidebarSections?.characters ?? current.sidebarSections.characters,
      personas: partial.sidebarSections?.personas ?? current.sidebarSections.personas,
      chats: partial.sidebarSections?.chats ?? current.sidebarSections.chats
    },
    theme: partial.theme ?? current.theme
  }
}

export const getUiState = async (): Promise<AppUiState> => {
  const row = await get<UiStateRow>('settings', UI_STATE_KEY)
  if (!row?.value) {
    return { ...DEFAULT_UI_STATE, theme: resolveTheme({}) }
  }

  try {
    const parsed = JSON.parse(row.value) as Partial<AppUiState>
    return {
      ...mergeUiState(parsed, DEFAULT_UI_STATE),
      theme: resolveTheme(parsed)
    }
  } catch {
    return { ...DEFAULT_UI_STATE, theme: resolveTheme({}) }
  }
}

export const saveUiState = async (partial: Partial<AppUiState>): Promise<AppUiState> => {
  const current = await getUiState()
  const next = mergeUiState(partial, current)
  await putSilent('settings', { key: UI_STATE_KEY, value: JSON.stringify(next) })
  return next
}
