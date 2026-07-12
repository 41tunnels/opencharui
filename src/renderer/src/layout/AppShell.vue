<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@renderer/stores/app'
import AppHeader from '@renderer/components/AppHeader.vue'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import OllamaSetupOverlay from '@renderer/components/OllamaSetupOverlay.vue'

const route = useRoute()
const store = useAppStore()

const isSetupPreview = computed(() => {
  if (!import.meta.env.DEV) return false
  if (route.query.setup === 'production') return true
  return new URLSearchParams(window.location.search).get('setup') === 'production'
})

let unsubChunk: (() => void) | undefined
let unsubDone: (() => void) | undefined
let unsubError: (() => void) | undefined
let unsubCancelled: (() => void) | undefined

onMounted(() => {
  unsubChunk = window.api.chat.onChunk(({ chatId, delta }) => {
    if (store.activeChat?.id === chatId) store.appendStreaming(delta)
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
  unsubChunk?.()
  unsubDone?.()
  unsubError?.()
  unsubCancelled?.()
})
</script>

<template>
  <div class="ui-shell flex h-screen flex-col">
    <AppHeader />
    <div class="flex min-h-0 flex-1">
      <AppSidebar />
      <main class="flex min-w-0 flex-1 flex-col">
        <RouterView :key="route.fullPath" />
      </main>
    </div>

    <OllamaSetupOverlay
      v-if="(!store.llmStatus.ollamaAvailable || isSetupPreview) && route.name !== 'settings'"
      :preview-production="isSetupPreview"
    />
  </div>
</template>
