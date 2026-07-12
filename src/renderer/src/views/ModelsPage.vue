<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import type { ModelInfo, ModelNotes, ModelPullProgress } from '@shared/types'
import { formatBytes, estimateTimeRemaining } from '@shared/format-duration'
import { useAppStore } from '@renderer/stores/app'

const router = useRouter()
const store = useAppStore()

const loading = ref(true)
const loadError = ref<string | null>(null)
const models = ref<ModelInfo[]>([])
const notes = ref<ModelNotes>({})

const downloadName = ref('')
const pulling = ref(false)
const pullProgress = ref<ModelPullProgress | null>(null)
const pullStartedAt = ref<number | null>(null)
const pullError = ref<string | null>(null)
const pullSuccess = ref(false)
let pullAbortController: AbortController | null = null

const removingModelId = ref<string | null>(null)
const removeError = ref<string | null>(null)

const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

const ollamaAvailable = computed(() => store.llmStatus.ollamaAvailable)

const pullEta = computed(() => {
  const progress = pullProgress.value
  const startedAt = pullStartedAt.value
  if (!progress || startedAt === null) return null
  if (progress.completed === undefined || progress.total === undefined) return null
  return estimateTimeRemaining(progress.completed, progress.total, startedAt)
})

const loadModels = async () => {
  loading.value = true
  loadError.value = null

  try {
    await store.refreshLlm()
    const [modelList, savedNotes] = await Promise.all([
      window.api.llm.listModels(),
      window.api.modelNotes.getAll()
    ])
    models.value = modelList
    notes.value = savedNotes
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load models'
  } finally {
    loading.value = false
  }
}

onMounted(loadModels)

onUnmounted(() => {
  pullAbortController?.abort()
  for (const timer of noteSaveTimers.values()) {
    clearTimeout(timer)
  }
  noteSaveTimers.clear()
})

const scheduleNoteSave = (modelId: string, note: string) => {
  const existing = noteSaveTimers.get(modelId)
  if (existing) clearTimeout(existing)

  noteSaveTimers.set(
    modelId,
    setTimeout(async () => {
      noteSaveTimers.delete(modelId)
      try {
        await window.api.modelNotes.set(modelId, note)
        if (note.trim()) {
          notes.value = { ...notes.value, [modelId]: note }
        } else {
          const next = { ...notes.value }
          delete next[modelId]
          notes.value = next
        }
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : 'Failed to save note'
      }
    }, 500)
  )
}

const updateNote = (modelId: string, event: Event) => {
  const note = (event.target as HTMLTextAreaElement).value
  notes.value = { ...notes.value, [modelId]: note }
  scheduleNoteSave(modelId, note)
}

const startDownload = async () => {
  const name = downloadName.value.trim()
  if (!name || pulling.value) return

  pullError.value = null
  pullSuccess.value = false
  pulling.value = true
  pullProgress.value = { status: 'starting' }
  pullStartedAt.value = Date.now()
  pullAbortController = new AbortController()

  try {
    await window.api.llm.pullModel(
      name,
      (progress) => {
        pullProgress.value = progress
      },
      pullAbortController.signal
    )
    downloadName.value = ''
    pullSuccess.value = true
    await loadModels()
    setTimeout(() => {
      pullSuccess.value = false
    }, 2000)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      pullError.value = 'Download cancelled'
    } else {
      pullError.value = err instanceof Error ? err.message : 'Download failed'
    }
  } finally {
    pulling.value = false
    pullProgress.value = null
    pullStartedAt.value = null
    pullAbortController = null
  }
}

const cancelDownload = () => {
  pullAbortController?.abort()
}

const removeModel = async (model: ModelInfo) => {
  if (removingModelId.value) return
  if (!confirm(`Remove "${model.name}" from Ollama? This cannot be undone.`)) return

  removingModelId.value = model.id
  removeError.value = null

  try {
    await window.api.llm.deleteModel(model.name)
    await window.api.modelNotes.delete(model.id)
    await loadModels()
  } catch (err) {
    removeError.value = err instanceof Error ? err.message : 'Failed to remove model'
  } finally {
    removingModelId.value = null
  }
}

const goBack = () => {
  if (window.history.length > 1) {
    router.back()
    return
  }
  router.push({ name: 'home' })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-2xl space-y-6">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-xl font-semibold">Models</h2>
          <p class="mt-1 text-sm ui-text-muted">Manage Ollama models installed on this machine.</p>
        </div>
        <button type="button" class="ui-btn-ghost text-sm" @click="goBack">Back</button>
      </div>

      <div
        v-if="!ollamaAvailable"
        class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      >
        Ollama is not connected. Install and run
        <a
          href="https://ollama.com"
          target="_blank"
          rel="noopener noreferrer"
          class="underline"
          >Ollama</a
        >
        locally. For production, set
        <code class="text-red-800 dark:text-red-200">OLLAMA_ORIGINS=*</code> so the browser can reach it.
      </div>

      <section class="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h3 class="text-sm font-medium">Download model</h3>
        <p class="text-sm ui-text-muted">
          Enter a model name from the
          <a
            href="https://ollama.com/library"
            target="_blank"
            rel="noopener noreferrer"
            class="text-neutral-800 underline dark:text-neutral-200"
            >Ollama library</a
          >
          (e.g. <code class="text-neutral-700 dark:text-neutral-300">llama3.2</code>,
          <code class="text-neutral-700 dark:text-neutral-300">mistral</code>).
        </p>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="downloadName"
            type="text"
            class="ui-input min-w-0 flex-1 px-3 py-2 text-sm"
            placeholder="Model name"
            :disabled="pulling || !ollamaAvailable"
            @keydown.enter.prevent="startDownload"
          />
          <button
            type="button"
            class="ui-btn-primary px-4 py-2 text-sm"
            :disabled="pulling || !ollamaAvailable || !downloadName.trim()"
            @click="startDownload"
          >
            Download
          </button>
        </div>

        <div
          v-if="pulling && pullProgress"
          class="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50"
        >
          <div class="flex items-center justify-between gap-3 text-sm">
            <span class="capitalize ui-text-muted">{{ pullProgress.status }}</span>
            <button type="button" class="ui-btn-ghost px-2 py-1 text-xs" @click="cancelDownload">
              Cancel
            </button>
          </div>
          <div
            v-if="pullProgress.percent !== undefined"
            class="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          >
            <div
              class="h-full rounded-full bg-neutral-800 transition-all duration-300 dark:bg-neutral-200"
              :style="{ width: `${pullProgress.percent}%` }"
            />
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs ui-text-subtle">
            <span v-if="pullProgress.completed !== undefined && pullProgress.total !== undefined">
              {{ formatBytes(pullProgress.completed) }} / {{ formatBytes(pullProgress.total) }}
              <span v-if="pullProgress.percent !== undefined">({{ pullProgress.percent }}%)</span>
            </span>
            <span v-if="pullEta">{{ pullEta }}</span>
          </div>
        </div>

        <p v-if="pullSuccess" class="text-sm text-green-600 dark:text-green-400">Download complete.</p>
        <p v-if="pullError" class="text-sm text-red-600 dark:text-red-400">{{ pullError }}</p>
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium">Installed models</h3>
          <button
            type="button"
            class="ui-btn-outline px-3 py-1.5 text-sm"
            :disabled="loading"
            @click="loadModels"
          >
            Refresh
          </button>
        </div>

        <p v-if="loading" class="text-sm ui-text-muted">Loading models...</p>
        <p v-else-if="loadError" class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>
        <p v-else-if="models.length === 0" class="text-sm ui-text-muted">
          No models installed yet. Download one above or run
          <code class="text-neutral-700 dark:text-neutral-300">ollama pull &lt;model&gt;</code> in a terminal.
        </p>

        <p v-if="removeError" class="text-sm text-red-600 dark:text-red-400">{{ removeError }}</p>

        <ul v-if="!loading && models.length > 0" class="space-y-3">
          <li
            v-for="model in models"
            :key="model.id"
            class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium">{{ model.name }}</p>
                <p v-if="model.sizeBytes !== undefined" class="mt-0.5 text-xs ui-text-subtle">
                  {{ formatBytes(model.sizeBytes) }}
                </p>
              </div>
              <button
                type="button"
                class="ui-btn-outline px-3 py-1.5 text-sm text-red-600 dark:text-red-400"
                :disabled="!ollamaAvailable || removingModelId === model.id"
                @click="removeModel(model)"
              >
                {{ removingModelId === model.id ? 'Removing...' : 'Remove' }}
              </button>
            </div>
            <label class="mt-3 block">
              <span class="mb-1 block text-xs ui-text-muted">Note</span>
              <textarea
                :value="notes[model.id] ?? ''"
                rows="2"
                class="ui-input w-full resize-none px-3 py-2 text-sm"
                placeholder="Optional note about this model..."
                @input="updateNote(model.id, $event)"
              />
            </label>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
