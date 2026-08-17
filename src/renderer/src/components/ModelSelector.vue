<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAppStore } from '@renderer/stores/app'
import type { ModelNotes } from '@shared/types'

const store = useAppStore()
const open = ref(false)
const modelNotes = ref<ModelNotes>({})

const label = computed(() => store.selectedModel?.name ?? 'Select model')

const noteFor = (modelId: string): string | null => {
  const note = modelNotes.value[modelId]?.trim()
  return note || null
}

const loadNotes = async () => {
  modelNotes.value = await window.api.modelNotes.getAll()
}

watch(open, (isOpen) => {
  if (isOpen) void loadNotes()
})

const selectModel = async (modelId: string) => {
  store.selectedModelId = modelId
  if (store.activeChat) {
    await window.api.chats.setModel(store.activeChat.id, modelId, 'ollama')
  }
  open.value = false
}
</script>

<template>
  <div class="relative min-w-0">
    <button
      class="ui-btn-outline ui-mono flex min-w-0 items-center gap-1.5 px-1.5 py-[7px] md:gap-2 md:px-3"
      @click="open = !open"
    >
      <span class="max-w-[5.5rem] truncate md:max-w-[180px]">{{ label }}</span>
      <span class="ui-text-subtle shrink-0 text-[9px]">▼</span>
    </button>

    <div
      v-if="open"
      class="ui-card absolute left-0 top-full z-50 mt-1.5 max-h-80 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto py-1.5"
      style="border-radius: var(--radius-2); box-shadow: var(--shadow-panel)"
    >
      <p class="ui-eyebrow px-3 pb-2 pt-1.5">Ollama models</p>
      <button
        v-for="model in store.models"
        :key="model.id"
        class="block w-full px-3 py-2 text-left ui-hover-row"
        :class="store.selectedModelId === model.id ? 'ui-active-row' : ''"
        style="border-radius: 0"
        @click="selectModel(model.id)"
      >
        <span class="ui-mono ui-text-strong block truncate">{{ model.name }}</span>
        <span v-if="noteFor(model.id)" class="ui-mono-sm ui-text-subtle mt-1 block truncate">
          {{ noteFor(model.id) }}
        </span>
      </button>
      <p v-if="store.models.length === 0" class="ui-text-muted px-3 py-2 text-sm">
        No models available — start Ollama and pull a model
      </p>
    </div>
  </div>
</template>
