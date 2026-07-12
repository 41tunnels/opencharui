import type { AppTheme } from './types'

export const THEME_STORAGE_KEY = 'opencharui-theme'

const writeThemeCache = (theme: AppTheme): void => {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Brave private mode / strict shields may block storage APIs.
    }
  }
}

export const readThemeFromDocument = (): AppTheme | null => {
  if (typeof document === 'undefined') return null
  const attr = document.documentElement.dataset.theme
  if (attr === 'light' || attr === 'dark') return attr
  return null
}

export const applyTheme = (theme: AppTheme): void => {
  const root = document.documentElement
  root.dataset.theme = theme
  root.classList.remove('dark', 'light')
  root.classList.add(theme)
  root.style.colorScheme = theme
  writeThemeCache(theme)
}

export const cacheTheme = (theme: AppTheme): void => {
  applyTheme(theme)
}

export const readCachedTheme = (): AppTheme | null => {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const cached = storage.getItem(THEME_STORAGE_KEY)
      if (cached === 'light' || cached === 'dark') return cached
    } catch {
      // ignore storage errors
    }
  }
  return readThemeFromDocument()
}
