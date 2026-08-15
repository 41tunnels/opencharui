<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/prompt-builder'
import { resolveChatContextWindowSize } from '@shared/chat-settings'
import { useAppStore } from '@renderer/stores/app'
import NumberInput from '@renderer/components/NumberInput.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const loading = ref(true)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const saving = ref(false)

const personaId = ref('')
const systemPrompt = ref('')
const temperature = ref('')
const topP = ref('')
const maxTokens = ref('')
const contextWindowSize = ref(20)
const keepAliveMinutes = ref('')
const summary = ref('')
const summaryBusy = ref(false)
const summaryNotice = ref<string | null>(null)
const summaryError = ref<string | null>(null)

const chatId = computed(() => route.params.id as string)
const chat = computed(() =>
  store.activeChat?.id === chatId.value ? store.activeChat : null
)
const characterDefaults = computed(() => chat.value?.character?.defaultParams)

const loadChatSettings = async () => {
  loading.value = true
  loadError.value = null
  saveError.value = null

  try {
    await store.refreshPersonas()
    if (!chat.value || chat.value.id !== chatId.value) {
      await store.loadChat(chatId.value)
    }
    const current = store.activeChat
    if (!current) {
      loadError.value = 'Chat not found'
      return
    }

    personaId.value = current.personaId ?? current.persona?.id ?? ''
    systemPrompt.value = current.systemPrompt ?? ''
    temperature.value =
      current.temperature !== undefined ? String(current.temperature) : ''
    topP.value = current.topP !== undefined ? String(current.topP) : ''
    maxTokens.value = current.maxTokens !== undefined ? String(current.maxTokens) : ''
    contextWindowSize.value = resolveChatContextWindowSize(current)
    keepAliveMinutes.value =
      current.keepAliveMinutes !== undefined ? String(current.keepAliveMinutes) : ''
    summary.value = current.summary ?? ''
    summaryNotice.value = null
    summaryError.value = null
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load chat settings'
  } finally {
    loading.value = false
  }
}

onMounted(loadChatSettings)
watch(chatId, loadChatSettings)

const summarizedCount = computed(() => {
  const messages = chat.value?.messages ?? []
  const through = chat.value?.summarizedThrough
  if (!through) return 0
  const index = messages.findIndex((m) => m.id === through)
  return index === -1 ? 0 : index + 1
})

const runSummaryAction = async (
  action: () => Promise<string | null>
): Promise<void> => {
  summaryBusy.value = true
  summaryError.value = null
  summaryNotice.value = null
  try {
    summaryNotice.value = await action()
    const refreshed = await window.api.chats.get(chatId.value)
    summary.value = refreshed.summary ?? ''
    if (store.activeChat?.id === refreshed.id) store.activeChat = refreshed
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Summary action failed'
  } finally {
    summaryBusy.value = false
  }
}

const rebuildSummary = () =>
  runSummaryAction(async () => {
    const result = await window.api.chat.rebuildSummary(chatId.value)
    return result
      ? `Folded ${result.folded} messages, keeping the last ${result.keptVerbatim} verbatim.`
      : 'This chat is still short enough to send in full — nothing to summarise yet.'
  })

const clearSummary = () =>
  runSummaryAction(async () => {
    await window.api.chat.clearSummary(chatId.value)
    return 'Summary cleared. The full history will be sent again until it is compacted.'
  })

const saveSummaryEdits = () =>
  runSummaryAction(async () => {
    const through = chat.value?.summarizedThrough
    if (!through) throw new Error('There is no summary to edit yet')
    await window.api.chat.saveSummary(chatId.value, summary.value, through)
    return 'Summary saved.'
  })

const parseOptionalNumber = (value: string | number): number | undefined => {
  if (value === '' || value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error('Generation settings must be valid numbers')
    return value
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (Number.isNaN(parsed)) throw new Error('Generation settings must be valid numbers')
  return parsed
}

const save = async () => {
  if (!chatId.value) return
  saving.value = true
  saveError.value = null

  try {
    const keepAlive = parseOptionalNumber(keepAliveMinutes.value)
    if (
      keepAlive !== undefined &&
      (!Number.isInteger(keepAlive) || keepAlive < -1)
    ) {
      throw new Error('Keep model loaded must be an integer ≥ -1')
    }

    const updated = await window.api.chats.saveSettings(chatId.value, {
      ...(store.personas.length > 1 ? { personaId: personaId.value } : {}),
      systemPrompt: systemPrompt.value,
      temperature: parseOptionalNumber(temperature.value),
      topP: parseOptionalNumber(topP.value),
      maxTokens: parseOptionalNumber(maxTokens.value),
      contextWindowSize: contextWindowSize.value,
      keepAliveMinutes: keepAlive
    })

    if (store.activeChat?.id === updated.id) {
      store.activeChat = updated
    }
    await store.refreshChats()
    await router.push({ name: 'chat', params: { id: chatId.value } })
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Failed to save settings'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
    <div class="mx-auto w-full max-w-lg space-y-6">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-xl font-semibold">Chat settings</h2>
          <p v-if="chat" class="truncate text-sm ui-text-subtle">{{ chat.title }}</p>
        </div>
        <button
          type="button"
          class="ui-btn-ghost shrink-0 text-sm"
          @click="router.push({ name: 'chat', params: { id: chatId } })"
        >
          Back to chat
        </button>
      </div>

      <p v-if="loading" class="text-sm ui-text-muted">Loading...</p>
      <p v-if="loadError" class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>

      <template v-if="!loading && !loadError">
        <label v-if="store.personas.length > 1" class="block">
          <span class="mb-1 block text-sm ui-text-muted">Persona</span>
          <select
            v-model="personaId"
            class="ui-input w-full px-3 py-2 text-sm"
          >
            <option
              v-for="persona in store.personas"
              :key="persona.id"
              :value="persona.id"
            >
              {{ persona.name }}
            </option>
          </select>
          <p class="mt-1 text-xs ui-text-subtle">
            This controls the user name and user description injected into the prompt.
          </p>
        </label>

        <label class="block">
          <span class="mb-1 block text-sm ui-text-muted">Chat system prompt</span>
          <textarea
            v-model="systemPrompt"
            rows="6"
            class="ui-input w-full px-3 py-2 text-sm"
            placeholder="Leave empty to use the global system prompt from Settings"
          />
          <p class="mt-1 text-xs ui-text-subtle">
            Appended after the global system prompt from Settings. Character and persona details are
            still appended automatically. Use <code class="text-neutral-700 dark:text-neutral-300" v-pre>{{char}}</code> for the
            character name and <code class="text-neutral-700 dark:text-neutral-300" v-pre>{{user}}</code> for user name.
          </p>
        </label>

        <label class="block">
          <span class="mb-1 block text-sm ui-text-muted">Context window (message pairs)</span>
          <NumberInput
            v-model.number="contextWindowSize"
            :min="4"
          />
          <p class="mt-1 text-xs ui-text-subtle">
            How many user/assistant message pairs are included when generating replies.
          </p>
        </label>

        <label class="block">
          <span class="mb-1 block text-sm ui-text-muted">Keep model loaded (minutes)</span>
          <NumberInput
            v-model="keepAliveMinutes"
            :min="-1"
            placeholder="Default"
          />
          <p class="mt-1 text-xs ui-text-subtle">
            How long Ollama keeps the model in memory after a reply. Empty uses Ollama&apos;s
            default (usually 5 minutes). Use 0 to unload immediately, or -1 to keep it loaded
            indefinitely.
          </p>
        </label>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label class="block">
            <span class="mb-1 block text-sm ui-text-muted">Temperature</span>
            <NumberInput
              v-model="temperature"
              :step="0.05"
              :min="0"
              :max="2"
              :placeholder="
                characterDefaults?.temperature !== undefined
                  ? String(characterDefaults.temperature)
                  : 'Default'
              "
            />
            <p class="mt-1 text-xs ui-text-subtle">
              Randomness: 0.2 is focused, 0.7 balanced, 1.2+ more chaotic.
            </p>
          </label>
          <label class="block">
            <span class="mb-1 block text-sm ui-text-muted">Top P</span>
            <NumberInput
              v-model="topP"
              :step="0.05"
              :min="0"
              :max="1"
              :placeholder="
                characterDefaults?.topP !== undefined ? String(characterDefaults.topP) : 'Default'
              "
            />
            <p class="mt-1 text-xs ui-text-subtle">
              Sampling range: 0.8 tighter, 0.9 common, 1.0 broadest.
            </p>
          </label>
          <label class="block">
            <span class="mb-1 block text-sm ui-text-muted">Max tokens</span>
            <NumberInput
              v-model="maxTokens"
              :min="1"
              :placeholder="
                characterDefaults?.maxTokens !== undefined
                  ? String(characterDefaults.maxTokens)
                  : 'Default'
              "
            />
            <p class="mt-1 text-xs ui-text-subtle">
              Length cap: 128 short, 512 moderate, 1024+ long replies.
            </p>
          </label>
        </div>

        <div class="rounded-lg border border-neutral-300 p-3 dark:border-neutral-700">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span class="text-sm font-medium">Story so far</span>
            <span class="text-xs ui-text-subtle">
              {{
                summarizedCount > 0
                  ? `${summarizedCount} older messages compacted`
                  : 'Nothing compacted yet'
              }}
            </span>
          </div>
          <p class="mb-2 text-xs ui-text-subtle">
            Once a chat outgrows the model's context, its older turns are folded into these notes
            and the recent ones keep being sent in full. Nothing is deleted — clearing this sends
            the whole history again.
          </p>
          <textarea
            v-model="summary"
            rows="8"
            :disabled="summaryBusy"
            placeholder="No summary yet. One is written automatically when the chat grows large, or you can build it now."
            class="ui-input w-full resize-y font-mono text-xs"
          />
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="ui-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
              :disabled="summaryBusy"
              @click="rebuildSummary"
            >
              {{ summaryBusy ? 'Working…' : 'Rebuild from history' }}
            </button>
            <button
              type="button"
              class="ui-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
              :disabled="summaryBusy || !summarizedCount"
              @click="saveSummaryEdits"
            >
              Save edits
            </button>
            <button
              type="button"
              class="ui-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
              :disabled="summaryBusy || !summarizedCount"
              @click="clearSummary"
            >
              Clear
            </button>
            <span v-if="summaryNotice" class="text-xs ui-text-subtle">{{ summaryNotice }}</span>
            <span v-if="summaryError" class="text-xs text-red-600 dark:text-red-400">{{
              summaryError
            }}</span>
          </div>
        </div>

        <p class="text-xs ui-text-subtle">
          Leave generation fields empty to inherit from the linked character. Global system prompt
          default:
          <span class="ui-text-muted">{{ DEFAULT_SYSTEM_PROMPT.slice(0, 80) }}...</span>
        </p>

        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            Save settings
          </button>
          <span v-if="saveError" class="text-sm text-red-600 dark:text-red-400">{{ saveError }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
