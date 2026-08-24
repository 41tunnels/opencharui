<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import type { AppSettings, SyncStatus } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/prompt-builder'
import {
  DEFAULT_COMPACTION_INTERVAL,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_MAX_TOKENS,
  DEFAULT_COMPACTION_PROMPT,
  DEFAULT_COMPACTION_TEMPERATURE,
  DEFAULT_COMPACTION_TOP_P
} from '@shared/compaction'
import { DEFAULT_OLLAMA_URL } from '@browser/llm/ollama'
import { formatRelativeTime } from '@shared/format-time'
import { useAppStore } from '@renderer/stores/app'
import NumberInput from '@renderer/components/NumberInput.vue'
import PairingPanel from '@renderer/components/PairingPanel.vue'

const store = useAppStore()
const settings = ref<AppSettings>({
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  ollamaUrl: '',
  ollamaApiKey: '',
  activePairingId: '',
  compactionPrompt: DEFAULT_COMPACTION_PROMPT,
  compactionInterval: DEFAULT_COMPACTION_INTERVAL,
  compactionKeepRecent: DEFAULT_COMPACTION_KEEP_RECENT,
  compactionTemperature: DEFAULT_COMPACTION_TEMPERATURE,
  compactionTopP: DEFAULT_COMPACTION_TOP_P,
  compactionMaxTokens: DEFAULT_COMPACTION_MAX_TOKENS
})
const saved = ref(false)
const saveError = ref<string | null>(null)
const systemPromptTextarea = ref<HTMLTextAreaElement | null>(null)
const compactionPromptTextarea = ref<HTMLTextAreaElement | null>(null)

const syncStatus = ref<SyncStatus>(window.api.sync.getStatus())
let unsubscribeSync: (() => void) | null = null

// Relay users hold no bearer token — transport === 'relay' is what gates
// sync for them, not apiKey (mirrors sync/engine.ts's runSync gating).
const canSync = computed(
  () => store.llmStatus.transport === 'relay' || settings.value.ollamaApiKey.trim().length > 0
)
const syncing = computed(() => syncStatus.value.state === 'syncing')

const syncStatusText = computed(() => {
  switch (syncStatus.value.state) {
    case 'syncing':
      return 'Syncing…'
    case 'error':
      return syncStatus.value.error ?? 'Sync failed'
    case 'unsupported':
      return 'This Amallo version does not support sync'
    case 'disabled':
      return 'Device sync needs an Amallo connection'
    default:
      return syncStatus.value.lastSyncedAt
        ? `Last synced ${formatRelativeTime(syncStatus.value.lastSyncedAt)}`
        : 'Never synced'
  }
})

// The status ramp, not a colour per state: ok, warn, or the neutral "off" dot.
// An error keeps the warn dot and says so in words rather than turning red.
const syncStatusClass = computed(() => {
  switch (syncStatus.value.state) {
    case 'idle':
      return syncStatus.value.lastSyncedAt ? 'ui-status-ok' : ''
    case 'disabled':
      return ''
    default:
      // syncing, error and unsupported are all "in flight or needs attention".
      return 'ui-status-warn'
  }
})

const runSync = async () => {
  syncStatus.value = await window.api.sync.now()
}

const fitPromptHeight = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight + 12}px`
}

const fitSystemPromptHeight = () => fitPromptHeight(systemPromptTextarea.value)
const fitCompactionPromptHeight = () => fitPromptHeight(compactionPromptTextarea.value)

onMounted(async () => {
  settings.value = await window.api.settings.get()
  await nextTick()
  fitSystemPromptHeight()
  fitCompactionPromptHeight()
  unsubscribeSync = window.api.sync.onStatusChanged((status) => {
    syncStatus.value = status
  })
})

onUnmounted(() => {
  unsubscribeSync?.()
})

const save = async () => {
  saveError.value = null
  saved.value = false

  const settingsSnapshot: Partial<AppSettings> = {
    systemPrompt: settings.value.systemPrompt,
    ollamaUrl: settings.value.ollamaUrl.trim(),
    ollamaApiKey: settings.value.ollamaApiKey.trim(),
    compactionPrompt: settings.value.compactionPrompt,
    compactionInterval: Number(settings.value.compactionInterval),
    compactionKeepRecent: Number(settings.value.compactionKeepRecent),
    compactionTemperature: Number(settings.value.compactionTemperature),
    compactionTopP: Number(settings.value.compactionTopP),
    compactionMaxTokens: Number(settings.value.compactionMaxTokens)
  }

  const numeric = [
    settingsSnapshot.compactionInterval,
    settingsSnapshot.compactionKeepRecent,
    settingsSnapshot.compactionTemperature,
    settingsSnapshot.compactionTopP,
    settingsSnapshot.compactionMaxTokens
  ]
  if (numeric.some((value) => value === undefined || Number.isNaN(value))) {
    saveError.value = 'Compression settings must be valid numbers'
    return
  }
  if ((settingsSnapshot.compactionInterval ?? 0) < 1) {
    saveError.value = 'Compress every … messages must be at least 1'
    return
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

const refreshOllama = async () => {
  await store.refreshLlm()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
    <div class="mx-auto w-full max-w-lg space-y-6">
      <h2 class="ui-text-strong text-[21px] font-medium tracking-tight">Settings</h2>

      <label class="block">
        <span class="ui-eyebrow mb-1.5 block">System prompt</span>
        <textarea
          ref="systemPromptTextarea"
          v-model="settings.systemPrompt"
          rows="12"
          class="ui-input w-full resize-none px-3 py-2 text-sm"
          placeholder="Global roleplay instructions applied to every chat..."
          @input="fitSystemPromptHeight"
        />
        <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
          Applied to all chats. Character and persona details are appended automatically. Use
          <code class="ui-mono-sm ui-text-strong" v-pre>{{ char }}</code> for the character name and
          <code class="ui-mono-sm ui-text-strong" v-pre>{{ user }}</code> for the persona name.
        </p>
      </label>

      <div class="ui-card p-5">
        <h3 class="mb-2 text-sm font-medium">History compression</h3>
        <p class="mb-3 text-sm ui-text-muted">
          Long chats fold their older turns into a running &quot;story so far&quot; so the prompt
          stops growing. Compression runs in the background while you type, and the composer shows
          <code class="ui-mono-sm ui-text-strong">compressing...</code> while it works. Nothing is
          deleted — clearing a chat&apos;s summary sends its full history again.
        </p>

        <label class="mb-3 block">
          <span class="ui-eyebrow mb-1.5 block">Compression prompt</span>
          <textarea
            ref="compactionPromptTextarea"
            v-model="settings.compactionPrompt"
            rows="10"
            class="ui-input w-full resize-none px-3 py-2 text-sm"
            placeholder="How the model should summarise the folded turns..."
            @input="fitCompactionPromptHeight"
          />
          <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
            Sent as the system message when summarising. The previous summary is prepended
            automatically, so each pass folds the story forward instead of starting over.
          </p>
        </label>

        <div class="mb-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Compress every (messages)</span>
            <NumberInput v-model.number="settings.compactionInterval" :min="1" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              How many new messages must pile up before another pass runs.
            </p>
          </label>
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Never compress the last (messages)</span>
            <NumberInput v-model.number="settings.compactionKeepRecent" :min="0" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              Recent turns stay verbatim; the summary carries everything before them.
            </p>
          </label>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Temperature</span>
            <NumberInput
              v-model.number="settings.compactionTemperature"
              :step="0.05"
              :min="0"
              :max="2"
            />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              Low keeps it to recall: sampling creatively here invents events.
            </p>
          </label>
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Top P</span>
            <NumberInput v-model.number="settings.compactionTopP" :step="0.05" :min="0" :max="1" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              Sampling range for the summary. 0.9 matches Ollama&apos;s default.
            </p>
          </label>
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Max tokens</span>
            <NumberInput v-model.number="settings.compactionMaxTokens" :min="1" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              Length cap for the summary. It is read on every turn, so keep it small.
            </p>
          </label>
        </div>
      </div>

      <div class="ui-card p-5">
        <h3 class="mb-2 text-sm font-medium">Ollama</h3>
        <label class="mb-3 block">
          <span class="ui-eyebrow mb-1.5 block">Ollama URL</span>
          <input
            v-model="settings.ollamaUrl"
            type="url"
            class="ui-input w-full px-3 py-2 text-sm"
            :placeholder="DEFAULT_OLLAMA_URL"
          />
          <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
            Leave empty to use the default (<code class="ui-mono-sm ui-text-strong">/ollama</code>
            in dev, <code class="ui-mono-sm ui-text-strong">{{ DEFAULT_OLLAMA_URL }}</code> in
            production).
          </p>
        </label>
        <label class="mb-3 block">
          <span class="ui-eyebrow mb-1.5 block">API key</span>
          <input
            v-model="settings.ollamaApiKey"
            type="password"
            autocomplete="off"
            class="ui-input w-full px-3 py-2 text-sm"
            placeholder="Leave empty for a local Ollama without auth"
          />
          <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
            Sent as <code class="ui-mono-sm ui-text-strong">Authorization: Bearer …</code>
            — required for Amallo instances.
          </p>
        </label>
        <p class="mb-3 text-sm ui-text-muted">
          Install and run
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noopener noreferrer"
            class="ui-text-accent"
            >Ollama</a
          >
          locally, then pull a model (e.g.
          <code class="ui-mono-sm ui-text-strong">ollama pull llama3.2</code>).
        </p>
        <p class="mb-3 text-sm ui-text-muted">
          For remote or custom hosts, set the full base URL (e.g.
          <code class="ui-mono-sm ui-text-strong">http://192.168.1.10:11434</code>). Set
          <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS=*</code> on the server if the
          browser reports CORS errors. To reach an Ollama exposed via Amallo from anywhere, pair
          with it below instead.
        </p>
        <span
          class="ui-status"
          :class="
            store.llmStatus.ollamaAvailable
              ? 'ui-status-ok'
              : store.llmStatus.unauthorized
                ? 'ui-status-warn'
                : ''
          "
        >
          <span class="ui-status-dot" />
          <span v-if="store.llmStatus.ollamaAvailable">connected</span>
          <span v-else-if="store.llmStatus.unauthorized">unauthorized — check API key</span>
          <span v-else>not connected</span>
        </span>
        <button class="ui-btn-outline mt-3 px-3 py-1.5 text-sm" @click="refreshOllama">
          Detect Ollama
        </button>
      </div>

      <PairingPanel />

      <div class="ui-card p-5">
        <h3 class="mb-2 text-sm font-medium">Device sync</h3>
        <p class="mb-3 text-sm ui-text-muted">
          Sync your characters, personas and chats across every device connected to the same Amallo
          instance. Syncs automatically on launch and after changes.
        </p>
        <span class="ui-status" :class="syncStatusClass">
          <span class="ui-status-dot" />
          <span>{{ syncStatusText }}</span>
        </span>
        <button
          class="ui-btn-outline mt-3 px-3 py-1.5 text-sm"
          :disabled="!canSync || syncing"
          @click="runSync"
        >
          {{ syncing ? 'Syncing…' : 'Sync now' }}
        </button>
      </div>

      <div class="flex flex-wrap gap-3">
        <button class="ui-btn-primary px-4 py-2 text-sm" @click="save">Save settings</button>
        <span v-if="saved" class="self-center text-sm ui-text-strong">Saved</span>
        <span v-if="saveError" class="self-center text-sm ui-text-accent">{{ saveError }}</span>
      </div>
    </div>
  </div>
</template>
