import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createBrowserApi } from '@browser/api'
import { onDataChanged } from '@browser/sync'
import { startDeviceSync } from '@browser/device-sync'
import { applyTheme, readCachedTheme } from '@shared/theme'
import { useAppStore } from '@renderer/stores/app'
import App from './App.vue'
import router from './router'
import './app.css'

applyTheme(readCachedTheme() ?? 'light')

const bootstrap = async (): Promise<void> => {
  window.api = createBrowserApi()

  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)
  app.use(router)

  const store = useAppStore(pinia)
  await store.refreshData({ llm: true })
  await store.loadUiState({ syncTheme: true })

  onDataChanged(() => {
    if (store.isGenerating) {
      void Promise.all([store.refreshCharacters(), store.refreshChats()])
      return
    }
    // Other tab changed IndexedDB — refresh local lists, skip Ollama unless cache is stale.
    void store.refreshData({ llm: 'ifStale' })
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void store.refreshData({ llm: 'ifStale' })
    }
  })

  // Refresh this tab's UI when a sync run pulled remote changes into IndexedDB.
  window.api.sync.onStatusChanged((_status, appliedRemote) => {
    if (appliedRemote && !store.isGenerating) void store.refreshData({ llm: false })
  })
  startDeviceSync()

  // Keeps store.llmStatus.relayState live so AppShell's "don't flash the
  // setup overlay during a brief reconnect" check has real data — without
  // this, relayState only ever reflected whatever it was at the last
  // explicit refreshLlm() call. A transition to 'online' is worth an
  // uncached probe (the agent may have just come back); anything else is
  // a soft refresh so a flapping connection can't spam requests.
  window.api.relay.onStatusChanged((state) => {
    if (store.llmStatus.transport === 'relay') {
      void store.refreshLlm({ force: state === 'online' })
    }
  })

  app.mount('#app')
}

void bootstrap()
