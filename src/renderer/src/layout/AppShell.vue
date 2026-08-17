<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@renderer/stores/app'
import { useDelayedDisconnect } from '@renderer/composables/useDelayedDisconnect'
import AppHeader from '@renderer/components/AppHeader.vue'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import OllamaSetupOverlay from '@renderer/components/OllamaSetupOverlay.vue'

const MOBILE_MQ = '(max-width: 767px)'

const route = useRoute()
const store = useAppStore()

const isSetupPreview = computed(() => {
  if (!import.meta.env.DEV) return false
  if (route.query.setup === 'production') return true
  return new URLSearchParams(window.location.search).get('setup') === 'production'
})

const mobileSidebarOpen = computed(() => !store.uiState.sidebarCollapsed)

// A relay reconnect (Wi-Fi flip, tab resume) briefly reports
// ollamaAvailable === false while it's reconnecting — don't flash the
// full-screen setup modal for that; only show it once the relay actually
// reports the agent offline.
const suppressOverlayForRelay = computed(
  () => store.llmStatus.transport === 'relay' && store.llmStatus.relayState === 'connecting'
)

// Once a connection has been seen, a drop has to last a few seconds before the
// overlay takes over — a reconnect inside that window resets the timer, so a
// short outage never flashes the setup screen. A never-connected app still
// gets the overlay immediately.
const disconnected = useDelayedDisconnect(
  () => !store.llmStatus.ollamaAvailable && !suppressOverlayForRelay.value
)

const closeSidebarIfMobile = () => {
  if (window.matchMedia(MOBILE_MQ).matches) {
    store.setSidebarCollapsed(true)
  }
}

let unsubChunk: (() => void) | undefined
let unsubThinking: (() => void) | undefined
let unsubDone: (() => void) | undefined
let unsubError: (() => void) | undefined
let unsubCancelled: (() => void) | undefined
let mobileMq: MediaQueryList | undefined

const onMobileMqChange = (event: MediaQueryListEvent) => {
  if (event.matches) store.setSidebarCollapsed(true)
}

watch(
  () => route.fullPath,
  () => {
    closeSidebarIfMobile()
  }
)

onMounted(() => {
  closeSidebarIfMobile()
  mobileMq = window.matchMedia(MOBILE_MQ)
  mobileMq.addEventListener('change', onMobileMqChange)

  unsubChunk = window.api.chat.onChunk(({ chatId, delta }) => {
    if (store.activeChat?.id === chatId) store.appendStreaming(delta)
  })
  unsubThinking = window.api.chat.onThinking(({ chatId, delta }) => {
    if (store.activeChat?.id === chatId) store.appendThinking(delta)
  })
  unsubDone = window.api.chat.onDone(async ({ chatId }) => {
    if (store.activeChat?.id === chatId) {
      await store.finishGeneration(chatId)
    }
  })
  unsubError = window.api.chat.onError(({ chatId, error }) => {
    if (store.activeChat?.id === chatId) {
      store.error = error
      void store.finishGeneration(chatId)
    }
  })
  unsubCancelled = window.api.chat.onCancelled(({ chatId }) => {
    void store.handleGenerationCancelled(chatId)
    void store.refreshChats()
  })
})

onUnmounted(() => {
  mobileMq?.removeEventListener('change', onMobileMqChange)
  unsubChunk?.()
  unsubThinking?.()
  unsubDone?.()
  unsubError?.()
  unsubCancelled?.()
})
</script>

<template>
  <div class="ui-shell flex h-dvh flex-col">
    <AppHeader class="relative z-50" />
    <div class="relative flex min-h-0 flex-1">
      <div
        v-if="mobileSidebarOpen"
        class="fixed inset-0 z-30 bg-black/40 md:hidden"
        aria-hidden="true"
        @click="store.setSidebarCollapsed(true)"
      />
      <AppSidebar />
      <main class="flex min-w-0 flex-1 flex-col">
        <RouterView :key="route.fullPath" />
      </main>
    </div>

    <OllamaSetupOverlay
      v-if="(disconnected || isSetupPreview) && route.name !== 'settings'"
      :preview-production="isSetupPreview"
    />
  </div>
</template>
