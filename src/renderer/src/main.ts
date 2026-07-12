import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createBrowserApi } from '@browser/api'
import { onDataChanged } from '@browser/sync'
import { applyTheme, readCachedTheme } from '@shared/theme'
import { useAppStore } from '@renderer/stores/app'
import App from './App.vue'
import router from './router'
import './app.css'

applyTheme(readCachedTheme() ?? 'dark')

const bootstrap = async (): Promise<void> => {
  window.api = createBrowserApi()

  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)
  app.use(router)

  const store = useAppStore(pinia)
  await store.refreshData()
  await store.loadUiState({ syncTheme: true })

  onDataChanged(() => {
    if (store.isGenerating) {
      void Promise.all([store.refreshCharacters(), store.refreshChats()])
      return
    }
    void store.refreshData()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void store.refreshData()
    }
  })

  app.mount('#app')
}

void bootstrap()
