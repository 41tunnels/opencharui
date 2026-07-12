<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { Character, Message, Persona } from '@shared/types'
import { computeContextUsage, formatContextUsageLabel, formatTokenSpeed, estimateTokenCount } from '@shared/context-usage'
import FormattedMessageText from '@renderer/components/FormattedMessageText.vue'

const props = defineProps<{
  chatId: string
  messages: Message[]
  character?: Character
  persona?: Persona
  characterName?: string
  globalSystemPrompt: string
  chatSystemPrompt?: string
  contextWindowSize: number
  modelContextTokens: number
  streamingText: string
  isGenerating: boolean
  error: string | null
}>()

const emit = defineEmits<{
  send: [content: string]
  abort: []
  regenerate: []
  regenerateMultiple: [count: number]
  variationPrev: [messageId: string]
  variationNext: [messageId: string]
  editUserSave: [content: string]
  editAssistantSave: [content: string]
  deleteMessage: [messageId: string]
}>()

const input = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const editTextareaEl = ref<HTMLTextAreaElement | null>(null)
const editingMessageId = ref<string | null>(null)
const editingMessageRole = ref<Message['role'] | null>(null)
const editDraft = ref('')
const editBubbleWidth = ref<number | null>(null)
const editBubbleHeight = ref<number | null>(null)
const bubbleRefs = new Map<string, HTMLElement>()
const generationStartedAt = ref<number | null>(null)
const lastTokenSpeedByChat = ref<Record<string, string>>({})
/** null = viewing the in-progress regeneration; number = saved variation index */
const regenerationPreviewIndex = ref<number | null>(null)

const lastAssistantMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    if (props.messages[index]?.role === 'assistant') {
      return props.messages[index].id
    }
  }
  return null
})

const lastUserMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    if (props.messages[index]?.role === 'user') {
      return props.messages[index].id
    }
  }
  return null
})

const isRegeneratingLastAssistant = computed(() => {
  if (!props.isGenerating) return false
  const lastMessage = props.messages[props.messages.length - 1]
  return lastMessage?.role === 'assistant' && lastMessage.id === lastAssistantMessageId.value
})

const contextUsage = computed(() => {
  if (!props.character) return null

  return computeContextUsage({
    chat: { systemPrompt: props.chatSystemPrompt },
    globalSystemPrompt: props.globalSystemPrompt,
    character: props.character,
    persona: props.persona,
    messages: props.messages,
    historyWindow: props.contextWindowSize,
    modelContextTokens: props.modelContextTokens,
    draftInput: input.value
  })
})

const contextUsageLabel = computed(() =>
  contextUsage.value ? formatContextUsageLabel(contextUsage.value) : null
)

const contextUsageClass = computed(() => {
  const percent = contextUsage.value?.percent ?? 0
  if (percent >= 90) return 'text-red-600 dark:text-red-400'
  if (percent >= 70) return 'text-amber-600 dark:text-amber-400'
  return 'ui-text-subtle'
})

const liveTokenSpeedLabel = computed(() => {
  if (!props.isGenerating || generationStartedAt.value === null) return null
  return formatTokenSpeed(
    estimateTokenCount(props.streamingText),
    Date.now() - generationStartedAt.value
  )
})

const tokenSpeedLabel = computed(
  () => liveTokenSpeedLabel.value ?? lastTokenSpeedByChat.value[props.chatId] ?? null
)

watch(liveTokenSpeedLabel, (label) => {
  if (!label) return
  lastTokenSpeedByChat.value = { ...lastTokenSpeedByChat.value, [props.chatId]: label }
})

watch(
  () => props.isGenerating,
  (isGenerating) => {
    generationStartedAt.value = null
    if (!isGenerating) return
    if (props.streamingText.length > 0) {
      generationStartedAt.value = Date.now()
    }
  }
)

watch(
  () => props.streamingText,
  (streamingText) => {
    if (props.isGenerating && generationStartedAt.value === null && streamingText.length > 0) {
      generationStartedAt.value = Date.now()
    }
  }
)

watch(
  () => props.chatId,
  () => {
    generationStartedAt.value = null
    regenerationPreviewIndex.value = null
  }
)

watch(isRegeneratingLastAssistant, () => {
  regenerationPreviewIndex.value = null
})

const scrollToBottom = async () => {
  await nextTick()
  requestAnimationFrame(() => {
    if (scrollRef.value) {
      scrollRef.value.scrollTop = scrollRef.value.scrollHeight
    }
  })
}

const restoreScroll = async (scrollTop: number) => {
  await nextTick()
  requestAnimationFrame(() => {
    if (scrollRef.value) {
      scrollRef.value.scrollTop = scrollTop
    }
  })
}

const preservedScrollTop = ref<number | null>(null)

watch(
  () => [props.chatId, props.messages.length, props.streamingText, props.isGenerating] as const,
  (current, previous) => {
    if (preservedScrollTop.value !== null) return

    const [chatId, messageCount, streamingText, isGenerating] = current
    const previousChatId = previous?.[0]
    const previousMessageCount = previous?.[1] ?? messageCount

    if (previous === undefined || chatId !== previousChatId) {
      void scrollToBottom()
      return
    }

    if (isGenerating || streamingText) {
      void scrollToBottom()
      return
    }

    if (messageCount > previousMessageCount) {
      void scrollToBottom()
    }
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => props.messages,
  () => {
    if (preservedScrollTop.value === null) return
    const scrollTop = preservedScrollTop.value
    preservedScrollTop.value = null
    void restoreScroll(scrollTop)
  },
  { flush: 'post' }
)

watch(
  () => [lastUserMessageId.value, lastAssistantMessageId.value],
  () => {
    if (editingMessageId.value) {
      cancelEdit()
    }
  }
)

const submit = () => {
  const text = input.value.trim()
  if (!text || props.isGenerating) return
  input.value = ''
  emit('send', text)
}

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

const variationCount = (message: Message): number => {
  return message.variations?.length ?? 1
}

const variationIndex = (message: Message): number => {
  return message.activeVariationIndex ?? 0
}

const variationLabel = (message: Message): string => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    const savedCount = variationCount(message)
    const index =
      regenerationPreviewIndex.value === null ? savedCount : regenerationPreviewIndex.value
    return `${index + 1} / ${savedCount + 1}`
  }
  return `${variationIndex(message) + 1} / ${variationCount(message)}`
}

const canGoPrev = (message: Message): boolean => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    if (regenerationPreviewIndex.value === null) {
      return variationCount(message) > 0
    }
    return regenerationPreviewIndex.value > 0
  }
  return variationIndex(message) > 0
}

const canGoNext = (message: Message): boolean => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    return regenerationPreviewIndex.value !== null
  }
  return variationIndex(message) < variationCount(message) - 1
}

const goVariationPrev = (message: Message) => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    if (regenerationPreviewIndex.value === null) {
      regenerationPreviewIndex.value = variationCount(message) - 1
      return
    }
    regenerationPreviewIndex.value -= 1
    return
  }
  emit('variationPrev', message.id)
}

const goVariationNext = (message: Message) => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    if (regenerationPreviewIndex.value === null) return
    if (regenerationPreviewIndex.value >= variationCount(message) - 1) {
      regenerationPreviewIndex.value = null
    } else {
      regenerationPreviewIndex.value += 1
    }
    return
  }
  emit('variationNext', message.id)
}

const isLatestAssistantMessage = (message: Message): boolean => {
  return message.role === 'assistant' && message.id === lastAssistantMessageId.value
}

const isLatestUserMessage = (message: Message): boolean => {
  return message.role === 'user' && message.id === lastUserMessageId.value
}

const canEditMessage = (message: Message): boolean => {
  return isLatestUserMessage(message) || isLatestAssistantMessage(message)
}

const isEditingMessage = (message: Message): boolean => {
  return editingMessageId.value === message.id
}

const setBubbleRef = (el: Element | { $el?: Element } | null, messageId: string) => {
  if (el instanceof HTMLElement) {
    bubbleRefs.set(messageId, el)
  } else {
    bubbleRefs.delete(messageId)
  }
}

const setEditTextareaRef = (el: Element | { $el?: Element } | null) => {
  editTextareaEl.value = el instanceof HTMLTextAreaElement ? el : null
}

const editBubbleStyle = (message: Message): Record<string, string> | undefined => {
  if (!isEditingMessage(message)) return undefined
  if (!editBubbleWidth.value || !editBubbleHeight.value) return undefined
  return {
    width: `${editBubbleWidth.value}px`,
    height: `${editBubbleHeight.value}px`,
    minHeight: `${editBubbleHeight.value}px`
  }
}

const resizeEditTextarea = () => {
  const textarea = editTextareaEl.value
  if (!textarea || !editBubbleHeight.value) return

  const paddingY = 24
  const neededBubbleHeight = textarea.scrollHeight + paddingY
  if (neededBubbleHeight > editBubbleHeight.value) {
    editBubbleHeight.value = neededBubbleHeight
  }
}

const startEdit = async (message: Message) => {
  if (!canEditMessage(message)) return
  if (props.isGenerating && !isLatestUserMessage(message)) return

  const bubble = bubbleRefs.get(message.id)
  if (!bubble) return

  editBubbleWidth.value = bubble.offsetWidth
  editBubbleHeight.value = bubble.offsetHeight
  editDraft.value = message.content
  editingMessageId.value = message.id
  editingMessageRole.value = message.role

  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resizeEditTextarea()
      editTextareaEl.value?.focus()
    })
  })
}

const cancelEdit = () => {
  editingMessageId.value = null
  editingMessageRole.value = null
  editDraft.value = ''
  editBubbleWidth.value = null
  editBubbleHeight.value = null
  editTextareaEl.value = null
}

const saveEdit = () => {
  const text = editDraft.value.trim()
  if (!text || !editingMessageRole.value) return
  if (props.isGenerating && editingMessageRole.value !== 'user') return
  preservedScrollTop.value = scrollRef.value?.scrollTop ?? 0
  const role = editingMessageRole.value
  cancelEdit()
  if (role === 'user') {
    emit('editUserSave', text)
  } else if (role === 'assistant') {
    emit('editAssistantSave', text)
  }
}

const onEditKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    saveEdit()
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

const showMessageActions = (message: Message): boolean => {
  if (isEditingMessage(message)) return false
  if (props.isGenerating) {
    return isLatestUserMessage(message) || isLatestAssistantMessage(message)
  }
  return true
}

const messageDisplayContent = (message: Message): string => {
  if (isRegeneratingLastAssistant.value && isLatestAssistantMessage(message)) {
    if (regenerationPreviewIndex.value !== null) {
      const variations = message.variations ?? [message.content]
      return variations[regenerationPreviewIndex.value] ?? message.content
    }
    return props.streamingText || message.content
  }
  return message.content
}

const isStreamingInMessage = (message: Message): boolean => {
  return (
    isRegeneratingLastAssistant.value &&
    isLatestAssistantMessage(message) &&
    regenerationPreviewIndex.value === null &&
    props.streamingText.length > 0
  )
}

const requestDelete = (message: Message) => {
  if (props.isGenerating) return
  if (!confirm('Delete this message? This cannot be undone.')) return
  if (isEditingMessage(message)) cancelEdit()
  preservedScrollTop.value = scrollRef.value?.scrollTop ?? 0
  emit('deleteMessage', message.id)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div ref="scrollRef" class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div v-if="messages.length === 0 && !streamingText" class="flex h-full items-center justify-center">
        <p class="ui-text-subtle">
          Start a conversation{{ characterName ? ` with ${characterName}` : '' }}
        </p>
      </div>

      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <div
          v-for="message in messages"
          :key="message.id"
          class="group flex"
          :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div class="max-w-[80%]">
            <div
              :ref="(el) => setBubbleRef(el, message.id)"
              class="rounded-2xl px-4 py-3 text-sm leading-relaxed"
              :class="[
                message.role === 'user'
                  ? 'chat-bubble-user border border-neutral-700 bg-neutral-800 text-neutral-50 dark:border-transparent dark:bg-neutral-700 dark:text-neutral-100'
                  : 'chat-bubble-assistant border border-neutral-300 bg-white text-neutral-950 shadow-sm dark:border-transparent dark:bg-neutral-800 dark:text-neutral-100',
                isEditingMessage(message) ? 'flex flex-col' : ''
              ]"
              :style="editBubbleStyle(message)"
            >
              <p
                v-if="message.role === 'assistant' && !isEditingMessage(message)"
                class="mb-1 text-xs font-medium ui-text-muted"
              >
                {{ characterName }}
              </p>
              <textarea
                v-if="isEditingMessage(message)"
                :ref="setEditTextareaRef"
                v-model="editDraft"
                autofocus
                class="m-0 min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed outline-none focus:ring-0"
                @input="resizeEditTextarea"
                @keydown="onEditKeydown"
              />
              <FormattedMessageText v-else :content="messageDisplayContent(message)" />
              <span v-if="isStreamingInMessage(message)" class="animate-pulse">▍</span>
            </div>

            <div class="mt-2 min-h-8">
              <div
                v-if="isEditingMessage(message)"
                class="flex items-center gap-2"
                :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <button
                  type="button"
                  class="ui-btn-outline px-2.5 py-1 text-xs"
                  @click="cancelEdit"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="ui-btn-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!editDraft.trim()"
                  @click="saveEdit"
                >
                  Save
                </button>
              </div>
              <div
                v-else-if="showMessageActions(message)"
                class="flex flex-wrap items-center gap-2 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <button
                  v-if="canEditMessage(message)"
                  type="button"
                  class="ui-btn-outline px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="isGenerating"
                  @click="startEdit(message)"
                >
                  Edit
                </button>
                <template v-if="isLatestAssistantMessage(message)">
                  <button
                    type="button"
                    class="ui-btn-outline px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    :disabled="isGenerating"
                    @click="emit('regenerate')"
                  >
                    Regenerate
                  </button>
                  <button
                    type="button"
                    class="ui-btn-outline px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    :disabled="isGenerating"
                    title="Regenerate 3 times"
                    @click="emit('regenerateMultiple', 3)"
                  >
                    ×3
                  </button>
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="ui-btn-outline px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                      :disabled="!canGoPrev(message)"
                      title="Previous variation"
                      @click="goVariationPrev(message)"
                    >
                      ←
                    </button>
                    <span class="min-w-[3rem] text-center text-xs ui-text-subtle">
                      {{ variationLabel(message) }}
                    </span>
                    <button
                      type="button"
                      class="ui-btn-outline px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                      :disabled="!canGoNext(message)"
                      title="Next variation"
                      @click="goVariationNext(message)"
                    >
                      →
                    </button>
                  </div>
                </template>
                <button
                  type="button"
                  class="rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950"
                  :disabled="isGenerating"
                  @click="requestDelete(message)"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="streamingText && !isRegeneratingLastAssistant" class="flex justify-start">
          <div class="chat-bubble-assistant max-w-[80%] rounded-2xl border border-neutral-300 bg-white px-4 py-3 text-sm leading-relaxed text-neutral-950 shadow-sm dark:border-transparent dark:bg-neutral-800 dark:text-neutral-100">
            <p v-if="characterName" class="mb-1 text-xs font-medium ui-text-muted">{{ characterName }}</p>
            <FormattedMessageText :content="streamingText" /><span class="animate-pulse">▍</span>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="error"
      class="border-t border-red-300 bg-red-50 px-6 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
    >
      {{ error }}
    </div>

    <div class="shrink-0 border-t border-neutral-200 px-6 py-4 dark:border-neutral-800">
      <div class="mx-auto flex max-w-3xl items-stretch gap-2">
        <div class="flex min-h-0 min-w-0 flex-1 self-stretch">
          <textarea
            v-model="input"
            class="ui-input h-full max-h-48 w-full resize-none overflow-y-auto rounded-xl px-4 py-3 text-sm placeholder-neutral-400 dark:placeholder-neutral-500"
            :placeholder="characterName ? `Message ${characterName}...` : 'Type a message...'"
            @keydown="onKeydown"
          />
        </div>
        <div class="flex shrink-0 flex-col justify-between gap-1.5 self-stretch">
          <div
            v-if="tokenSpeedLabel || contextUsageLabel"
            class="flex flex-col items-end gap-0.5 text-xs tabular-nums"
          >
            <p
              v-if="tokenSpeedLabel"
              class="ui-text-subtle"
              title="Estimated output speed"
            >
              {{ tokenSpeedLabel }}
            </p>
            <p
              v-if="contextUsageLabel"
              :class="contextUsageClass"
              :title="`${contextUsage?.usedTokens.toLocaleString()} / ${contextUsage?.limitTokens.toLocaleString()} estimated tokens`"
            >
              {{ contextUsageLabel }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="isGenerating"
              type="button"
              class="h-[38px] shrink-0 rounded-xl bg-red-200 px-4 text-sm font-medium text-red-900 hover:bg-red-300 dark:bg-red-900/80 dark:text-red-100 dark:hover:bg-red-900"
              @click="emit('abort')"
            >
              Stop
            </button>
            <button
              type="button"
              class="ui-btn-primary h-[38px] shrink-0 rounded-xl px-4 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!input.trim() || isGenerating"
              @click="submit"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
