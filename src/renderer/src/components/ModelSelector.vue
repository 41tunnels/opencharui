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
  <div class="relative">
    <button
      class="ui-btn-outline flex items-center gap-2 px-3 py-1.5 text-sm"
      @click="open = !open"
    >
      <span class="max-w-[180px] truncate">{{ label }}</span>
      <span class="ui-text-subtle">▼</span>
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
    >
      <p class="px-3 py-1 text-xs font-semibold uppercase ui-text-subtle">Ollama models</p>
      <button
        v-for="model in store.models"
        :key="model.id"
        class="block w-full px-3 py-2 text-left ui-hover-row"
        :class="store.selectedModelId === model.id ? 'ui-active-row' : ''"
        @click="selectModel(model.id)"
      >
        <span class="block text-sm">{{ model.name }}</span>
        <span
          v-if="noteFor(model.id)"
          class="mt-0.5 block truncate text-xs ui-text-subtle"
        >
          {{ noteFor(model.id) }}
        </span>
      </button>
      <p v-if="store.models.length === 0" class="px-3 py-2 text-sm ui-text-subtle">
        No models available — start Ollama and pull a model
      </p>
    </div>
  </div>
</template>
