<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/prompt-builder'
import { DEFAULT_OLLAMA_URL } from '@browser/llm/ollama'
import { useAppStore } from '@renderer/stores/app'

const router = useRouter()
const store = useAppStore()
const settings = ref<AppSettings>({
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  ollamaUrl: ''
})
const saved = ref(false)
const saveError = ref<string | null>(null)
const systemPromptTextarea = ref<HTMLTextAreaElement | null>(null)

const fitSystemPromptHeight = () => {
  const textarea = systemPromptTextarea.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight + 12}px`
}

onMounted(async () => {
  settings.value = await window.api.settings.get()
  await nextTick()
  fitSystemPromptHeight()
})

const save = async () => {
  saveError.value = null
  saved.value = false

  const settingsSnapshot: Partial<AppSettings> = {
    systemPrompt: settings.value.systemPrompt,
    ollamaUrl: settings.value.ollamaUrl.trim()
  }

  try {
    settings.value = await window.api.settings.save(settingsSnapshot)
    saved.value = true
    await store.refreshLlm()
    setTimeout(() => (saved.value = false), 2000)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Failed to save settings'
  }
}

const importCharacter = async () => {
  const character = await window.api.characters.import()
  if (character) {
    await store.refreshCharacters()
    router.push({ name: 'character-edit', params: { id: character.id } })
  }
}

const importPersona = async () => {
  const persona = await window.api.personas.import()
  if (persona) {
    await store.refreshPersonas()
    router.push({ name: 'persona-edit', params: { id: persona.id } })
  }
}

const refreshOllama = async () => {
  await store.refreshLlm()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-lg space-y-6">
      <h2 class="text-xl font-semibold">Settings</h2>

      <label class="block">
        <span class="mb-1 block text-sm ui-text-muted">System prompt</span>
        <textarea
          ref="systemPromptTextarea"
          v-model="settings.systemPrompt"
          rows="12"
          class="ui-input w-full resize-none px-3 py-2 text-sm"
          placeholder="Global roleplay instructions applied to every chat..."
          @input="fitSystemPromptHeight"
        />
        <p class="mt-1 text-xs ui-text-subtle">
          Applied to all chats. Character and persona details are appended automatically. Use
          <code class="text-neutral-700 dark:text-neutral-300" v-pre>{{char}}</code> for the character name and
          <code class="text-neutral-700 dark:text-neutral-300" v-pre>{{user}}</code> for the persona name.
        </p>
      </label>

      <div class="rounded-xl border border-neutral-200 bg-neutral-100/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/50">
        <h3 class="mb-2 text-sm font-medium">Ollama</h3>
        <label class="mb-3 block">
          <span class="mb-1 block text-sm ui-text-muted">Ollama URL</span>
          <input
            v-model="settings.ollamaUrl"
            type="url"
            class="ui-input w-full px-3 py-2 text-sm"
            :placeholder="DEFAULT_OLLAMA_URL"
          />
          <p class="mt-1 text-xs ui-text-subtle">
            Leave empty to use the default
            (<code class="text-neutral-700 dark:text-neutral-300">/ollama</code> in dev,
            <code class="text-neutral-700 dark:text-neutral-300">{{ DEFAULT_OLLAMA_URL }}</code> in production).
          </p>
        </label>
        <p class="mb-3 text-sm ui-text-muted">
          Install and run
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-neutral-800 underline dark:text-neutral-200"
            >Ollama</a
          >
          locally, then pull a model (e.g. <code class="text-neutral-700 dark:text-neutral-300">ollama pull llama3.2</code>).
        </p>
        <p class="mb-3 text-sm ui-text-muted">
          For remote or custom hosts, set the full base URL (e.g.
          <code class="text-neutral-700 dark:text-neutral-300">http://192.168.1.10:11434</code>).
          Set <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS=*</code> on the server if the browser reports CORS errors.
        </p>
        <p class="text-sm">
          Status:
          <span :class="store.llmStatus.ollamaAvailable ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
            {{ store.llmStatus.ollamaAvailable ? 'Connected' : 'Not connected' }}
          </span>
        </p>
        <button
          class="ui-btn-outline mt-3 px-3 py-1.5 text-sm"
          @click="refreshOllama"
        >
          Detect Ollama
        </button>
      </div>

      <div class="flex flex-wrap gap-3">
        <button
          class="ui-btn-primary px-4 py-2 text-sm"
          @click="save"
        >
          Save settings
        </button>
        <button
          class="ui-btn-outline px-4 py-2 text-sm"
          @click="importCharacter"
        >
          Import character (JSON or PNG)
        </button>
        <button
          class="ui-btn-outline px-4 py-2 text-sm"
          @click="importPersona"
        >
          Import persona JSON
        </button>
        <span v-if="saved" class="self-center text-sm text-green-600 dark:text-green-400">Saved</span>
        <span v-if="saveError" class="self-center text-sm text-red-600 dark:text-red-400">{{ saveError }}</span>
      </div>
    </div>
  </div>
</template>
