<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { chatToJson, safeParseChatSave } from '@shared/chat-schema'
import { resolveChatContextWindowSize } from '@shared/chat-settings'
import type { AppSettings } from '@shared/types'
import { useAppStore } from '@renderer/stores/app'
import ChatView from '@renderer/components/ChatView.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const rawMode = ref(false)
const rawJson = ref('')
const saveError = ref<string | null>(null)
const saving = ref(false)
const appSettings = ref<AppSettings | null>(null)
const modelContextTokens = ref(8192)
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
let skipTitleSaveOnBlur = false

const loadAppSettings = async () => {
  appSettings.value = await window.api.settings.get()
}

const loadModelContextTokens = async () => {
  const modelId = store.activeChat?.modelId ?? store.selectedModelId
  if (!modelId) {
    modelContextTokens.value = 8192
    return
  }

  modelContextTokens.value = await window.api.llm.getModelContextLength(modelId)
}

watch(
  () => [store.activeChat?.modelId, store.selectedModelId] as const,
  () => {
    void loadModelContextTokens()
  },
  { immediate: true }
)

// The real window comes from the running model, so it cannot be read while
// the connection is down — and a page opened before the Relay is up would
// otherwise keep showing the fallback (and a wildly wrong context
// percentage) until the chat is reopened.
watch(
  () => store.llmStatus.ollamaAvailable,
  (available) => {
    if (available) void loadModelContextTokens()
  }
)

const loadFromRoute = async () => {
  const id = route.params.id as string
  if (!id) return

  rawMode.value = false
  saveError.value = null
  editingTitle.value = false

  await loadAppSettings()

  if (!store.activeChat || store.activeChat.id !== id) {
    await store.loadChat(id)
  }

  if (store.activeChat) {
    rawJson.value = JSON.stringify(chatToJson(store.activeChat), null, 2)
  }

  await loadModelContextTokens()
  await store.generateOpeningForChat(id)
}

watch(() => route.params.id, loadFromRoute, { immediate: true })

const syncRawFromChat = () => {
  if (!store.activeChat) return
  rawJson.value = JSON.stringify(chatToJson(store.activeChat), null, 2)
}

const toggleRawMode = () => {
  if (store.isGenerating) return
  if (rawMode.value) {
    applyRawJson()
  } else {
    syncRawFromChat()
  }
  rawMode.value = !rawMode.value
}

const applyRawJson = (): boolean => {
  try {
    const parsed = JSON.parse(rawJson.value)
    const result = safeParseChatSave(parsed)
    if (!result.success) {
      saveError.value = result.error.errors.map((e) => e.message).join(', ')
      return false
    }
    if (store.activeChat && result.data.id !== store.activeChat.id) {
      saveError.value = 'Chat id cannot be changed'
      return false
    }
    saveError.value = null
    rawJson.value = JSON.stringify(result.data, null, 2)
    return true
  } catch {
    saveError.value = 'Invalid JSON'
    return false
  }
}

const saveJson = async () => {
  if (!store.activeChat || store.isGenerating) return
  saving.value = true
  saveError.value = null
  try {
    if (!applyRawJson()) return
    const parsed = safeParseChatSave(JSON.parse(rawJson.value))
    if (!parsed.success) return

    const saved = await window.api.chats.save(parsed.data)
    store.activeChat = saved
    if (saved.modelId) {
      store.selectedModelId = saved.modelId
    }
    await store.refreshChats()
    rawJson.value = JSON.stringify(chatToJson(saved), null, 2)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

const send = async (content: string) => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null
  store.addUserMessage(content)
  store.isGenerating = true
  store.streamingText = ''
  store.thinkingText = ''
  try {
    await window.api.chat.send(store.activeChat.id, content)
    await store.finishGeneration(store.activeChat.id)
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to send message'
    await store.finishGeneration(store.activeChat.id)
  }
}

const abort = () => {
  if (!store.activeChat) return
  window.api.chat.abort(store.activeChat.id)
  void store.finishGeneration(store.activeChat.id)
}

const runRegenerateLast = async (): Promise<boolean> => {
  if (!store.activeChat) return false
  store.streamingText = ''
  store.thinkingText = ''
  try {
    await window.api.chat.regenerateLast(store.activeChat.id)
    await store.finishGeneration(store.activeChat.id)
    syncRawFromChat()
    return true
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to regenerate message'
    await store.finishGeneration(store.activeChat.id)
    return false
  }
}

const regenerateLast = async () => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null
  store.isGenerating = true
  await runRegenerateLast()
}

const regenerateLastMultiple = async (count: number) => {
  if (!store.activeChat || store.isGenerating || count < 1) return
  store.error = null
  store.isGenerating = true

  for (let i = 0; i < count; i++) {
    if (!store.activeChat) break
    if (i > 0) {
      store.isGenerating = true
      store.streamingText = ''
      store.thinkingText = ''
    }
    const ok = await runRegenerateLast()
    if (!ok) break
  }
}

const variationPrev = async (messageId: string) => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null
  try {
    await window.api.chat.setVariation(store.activeChat.id, messageId, 'prev')
    await store.loadChat(store.activeChat.id)
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to change variation'
  }
}

const variationNext = async (messageId: string) => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null
  try {
    await window.api.chat.setVariation(store.activeChat.id, messageId, 'next')
    await store.loadChat(store.activeChat.id)
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to change variation'
  }
}

const editLastUserMessage = async (content: string) => {
  if (!store.activeChat) return
  store.error = null

  const messages = store.activeChat.messages
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  const shouldRegenerate =
    !store.isGenerating && lastUserIndex >= 0 && lastUserIndex === messages.length - 1
  const editedMessageId = lastUserIndex >= 0 ? messages[lastUserIndex]?.id : null

  if (editedMessageId) {
    store.activeChat.messages = store.activeChat.messages.map((message) =>
      message.id === editedMessageId ? { ...message, content } : message
    )
  }

  if (shouldRegenerate) {
    store.isGenerating = true
    store.streamingText = ''
    store.thinkingText = ''
  }

  try {
    await window.api.chat.editLastUserMessage(store.activeChat.id, content)
    if (shouldRegenerate) {
      await store.finishGeneration(store.activeChat.id)
    }
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to edit message'
    if (shouldRegenerate) {
      await store.finishGeneration(store.activeChat.id)
    } else if (!store.isGenerating) {
      await store.loadChat(store.activeChat.id)
    }
  }
}

const editLastAssistantMessage = async (content: string) => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null

  const messages = store.activeChat.messages
  let lastAssistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      lastAssistantIndex = index
      break
    }
  }
  const editedMessageId = lastAssistantIndex >= 0 ? messages[lastAssistantIndex]?.id : null

  if (editedMessageId) {
    store.activeChat.messages = store.activeChat.messages.map((message) =>
      message.id === editedMessageId ? { ...message, content } : message
    )
  }

  try {
    const updated = await window.api.chat.editLastAssistantMessage(store.activeChat.id, content)
    store.activeChat.messages = store.activeChat.messages.map((message) =>
      message.id === updated.id ? { ...message, ...updated } : message
    )
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to edit message'
    if (editedMessageId) {
      await store.loadChat(store.activeChat.id)
    }
  }
}

const deleteMessage = async (messageId: string) => {
  if (!store.activeChat || store.isGenerating) return
  store.error = null
  try {
    await window.api.chat.deleteMessage(store.activeChat.id, messageId)
    store.activeChat.messages = store.activeChat.messages.filter(
      (message) => message.id !== messageId
    )
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to delete message'
  }
}

const startRename = () => {
  if (!store.activeChat) return
  titleDraft.value = store.activeChat.title
  editingTitle.value = true
  skipTitleSaveOnBlur = false
  nextTick(() => {
    titleInput.value?.focus()
    titleInput.value?.select()
  })
}

const cancelRename = () => {
  skipTitleSaveOnBlur = true
  editingTitle.value = false
}

const saveTitle = async () => {
  if (!store.activeChat || !editingTitle.value) return
  editingTitle.value = false

  const trimmed = titleDraft.value.trim()
  if (!trimmed || trimmed === store.activeChat.title) return

  try {
    await window.api.chats.rename(store.activeChat.id, trimmed)
    store.activeChat.title = trimmed
    await store.refreshChats()
    syncRawFromChat()
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to rename chat'
  }
}

const onTitleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void saveTitle()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
    titleInput.value?.blur()
  }
}

const onTitleBlur = () => {
  if (skipTitleSaveOnBlur) {
    skipTitleSaveOnBlur = false
    return
  }
  void saveTitle()
}
</script>

<template>
  <div v-if="store.activeChat" class="flex min-h-0 flex-1 flex-col">
    <div
      class="ui-surface flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-3 md:px-6"
    >
      <div class="min-w-0 flex-1">
        <div class="group flex min-w-0 items-center gap-2">
          <input
            v-if="editingTitle"
            ref="titleInput"
            v-model="titleDraft"
            type="text"
            class="ui-input min-w-0 flex-1 px-2 py-1 text-sm font-medium"
            @keydown="onTitleKeydown"
            @blur="onTitleBlur"
          />
          <template v-else>
            <h2 class="min-w-0 truncate text-sm font-medium">{{ store.activeChat.title }}</h2>
            <button
              type="button"
              class="ui-micro ui-micro-bare ui-hover-reveal shrink-0 transition-opacity"
              title="Rename chat"
              @click="startRename"
            >
              Rename
            </button>
          </template>
        </div>
        <p
          v-if="store.activeChat.character || store.activeChat.persona"
          class="truncate text-xs ui-text-subtle"
        >
          <span v-if="store.activeChat.persona">as {{ store.activeChat.persona.name }}</span>
          <span v-if="store.activeChat.persona && store.activeChat.character"> · </span>
          <span v-if="store.activeChat.character">with {{ store.activeChat.character.name }}</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2 md:gap-3">
        <button
          type="button"
          class="ui-btn-ghost shrink-0 text-sm"
          @click="router.push({ name: 'chat-settings', params: { id: store.activeChat.id } })"
        >
          Settings
        </button>
        <button
          type="button"
          class="ui-btn-ghost shrink-0 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="store.isGenerating"
          @click="toggleRawMode"
        >
          {{ rawMode ? 'Chat mode' : 'JSON mode' }}
        </button>
      </div>
    </div>

    <div v-if="rawMode" class="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
      <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4">
        <p class="text-sm ui-text-muted">
          Edit the full chat record including messages. Character and persona details are not
          included; they come from the linked records.
        </p>
        <textarea
          v-model="rawJson"
          rows="24"
          class="ui-input ui-input-mono min-h-[50vh] w-full flex-1 p-4 text-xs md:min-h-[420px]"
        />
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="ui-btn-outline px-4 py-2 text-sm" @click="applyRawJson">
            Apply JSON
          </button>
          <button
            type="button"
            class="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
            :disabled="saving || store.isGenerating"
            @click="saveJson"
          >
            Save
          </button>
          <span v-if="saveError" class="text-sm ui-text-accent">{{ saveError }}</span>
        </div>
      </div>
    </div>

    <ChatView
      v-else
      :chat-id="store.activeChat.id"
      :messages="store.activeChat.messages"
      :character="store.activeChat.character"
      :persona="store.activeChat.persona"
      :character-name="store.activeChat.character?.name"
      :global-system-prompt="appSettings?.systemPrompt ?? ''"
      :chat-system-prompt="store.activeChat.systemPrompt"
      :context-window-size="resolveChatContextWindowSize(store.activeChat)"
      :model-context-tokens="modelContextTokens"
      :streaming-text="store.streamingText"
      :thinking-text="store.thinkingText"
      :is-generating="store.isGenerating"
      :error="store.error"
      @send="send"
      @abort="abort"
      @regenerate="regenerateLast"
      @regenerate-multiple="regenerateLastMultiple"
      @variation-prev="variationPrev"
      @variation-next="variationNext"
      @edit-user-save="editLastUserMessage"
      @edit-assistant-save="editLastAssistantMessage"
      @delete-message="deleteMessage"
    />
  </div>
</template>
