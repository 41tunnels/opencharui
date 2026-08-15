import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import type {
  AppTheme,
  AppUiState,
  CharacterSummary,
  ChatSummary,
  ChatWithMessages,
  LLMStatus,
  ModelInfo,
  Message,
  PersonaSummary
} from '@shared/types'
import { DEFAULT_UI_STATE } from '@shared/types'
import { applyTheme } from '@shared/theme'

export const useAppStore = defineStore('app', () => {
  const characters = ref<CharacterSummary[]>([])
  const personas = ref<PersonaSummary[]>([])
  const chats = ref<ChatSummary[]>([])
  const activeChat = ref<ChatWithMessages | null>(null)
  const llmStatus = ref<LLMStatus>({
    ollamaAvailable: false,
    usingAmallo: false,
    unauthorized: false,
    transport: 'direct',
    relayState: null
  })
  const models = ref<ModelInfo[]>([])
  const selectedModelId = ref<string | null>(null)
  const streamingText = ref('')
  /** Reasoning streamed by a thinking model before the reply starts. Kept
   * only to show that something is happening — never persisted, and
   * dropped the moment real content arrives. */
  const thinkingText = ref('')
  const isGenerating = ref(false)
  const error = ref<string | null>(null)
  const uiState = ref<AppUiState>({ ...DEFAULT_UI_STATE })

  const selectedModel = computed(() => models.value.find((m) => m.id === selectedModelId.value))

  const refreshCharacters = async () => {
    characters.value = await window.api.characters.list()
  }

  const refreshPersonas = async () => {
    personas.value = await window.api.personas.list()
  }

  const refreshChats = async () => {
    chats.value = await window.api.chats.list()
  }

  const refreshLlm = async (options: { force?: boolean } = { force: true }) => {
    const { status, models: nextModels } = await window.api.llm.refresh(options)
    llmStatus.value = status
    models.value = nextModels
    if (!selectedModelId.value && models.value.length > 0) {
      selectedModelId.value = models.value[0]?.id ?? null
    }
  }

  const loadUiState = async (options: { syncTheme?: boolean } = {}) => {
    const syncTheme = options.syncTheme ?? true
    const next = await window.api.ui.get()
    if (syncTheme) {
      uiState.value = next
      applyTheme(next.theme)
    } else {
      uiState.value = { ...next, theme: uiState.value.theme }
    }
  }

  const persistUiState = async (partial: Partial<AppUiState> = uiState.value) => {
    const theme = uiState.value.theme
    try {
      const saved = await window.api.ui.save(partial)
      uiState.value = { ...saved, theme: partial.theme ?? theme }
    } catch {
      // IndexedDB can fail in strict/private browser profiles.
    }
  }

  const setTheme = (theme: AppTheme) => {
    uiState.value = { ...uiState.value, theme }
    applyTheme(theme)
  }

  const setSidebarCollapsed = (sidebarCollapsed: boolean) => {
    if (uiState.value.sidebarCollapsed === sidebarCollapsed) return
    uiState.value = { ...uiState.value, sidebarCollapsed }
    void persistUiState({ sidebarCollapsed })
  }

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(!uiState.value.sidebarCollapsed)
  }

  const toggleSidebarSection = (section: 'characters' | 'personas' | 'chats') => {
    const sidebarSections = {
      ...uiState.value.sidebarSections,
      [section]: !uiState.value.sidebarSections[section]
    }
    uiState.value = { ...uiState.value, sidebarSections }
    void persistUiState({ sidebarSections })
  }

  const toggleTheme = () => {
    const theme: AppTheme = uiState.value.theme === 'dark' ? 'light' : 'dark'
    setTheme(theme)
    void persistUiState({ theme })
  }

  const isDarkTheme = computed(() => uiState.value.theme === 'dark')

  const refreshLocalData = async () => {
    await Promise.all([refreshCharacters(), refreshPersonas(), refreshChats()])
    if (activeChat.value) {
      await loadChat(activeChat.value.id)
    }
  }

  const refreshData = async (options: { llm?: boolean | 'ifStale' } = { llm: true }) => {
    const tasks: Promise<unknown>[] = [refreshLocalData()]
    if (options.llm === true) {
      tasks.push(refreshLlm({ force: true }))
    } else if (options.llm === 'ifStale') {
      tasks.push(refreshLlm({ force: false }))
    }
    await Promise.all(tasks)
  }

  const refreshAll = async () => {
    await Promise.all([refreshData({ llm: true }), loadUiState({ syncTheme: false })])
  }

  const loadChat = async (chatId: string) => {
    activeChat.value = await window.api.chats.get(chatId)
    if (activeChat.value.modelId) {
      selectedModelId.value = activeChat.value.modelId
    }
    streamingText.value = ''
    thinkingText.value = ''
    isGenerating.value = false
    error.value = null
  }

  const createChatForCharacter = async (characterId: string, personaId?: string) => {
    const chat = await window.api.chats.create(characterId, personaId)

    const modelId = selectedModelId.value
    if (modelId) {
      await window.api.chats.setModel(chat.id, modelId, 'ollama')
      chat.modelId = modelId
      chat.provider = 'ollama'
    }

    await refreshChats()
    activeChat.value = chat
    streamingText.value = ''
    thinkingText.value = ''
    error.value = null
    isGenerating.value = false
    return chat
  }

  const finishGeneration = async (chatId: string) => {
    try {
      const chat = await window.api.chats.get(chatId)
      if (!activeChat.value || activeChat.value.id === chatId) {
        activeChat.value = chat
        if (chat.modelId) {
          selectedModelId.value = chat.modelId
        }
      }
      await refreshChats()
    } catch {
      if (activeChat.value?.id === chatId) {
        activeChat.value = null
      }
    }
    isGenerating.value = false
    streamingText.value = ''
    thinkingText.value = ''
  }

  const handleChatDeleted = (chatId: string) => {
    if (activeChat.value?.id === chatId) {
      activeChat.value = null
    }
    isGenerating.value = false
    streamingText.value = ''
    thinkingText.value = ''
    error.value = null
  }

  const handleGenerationCancelled = async (chatId: string) => {
    if (activeChat.value?.id !== chatId) return

    isGenerating.value = false
    streamingText.value = ''
    thinkingText.value = ''

    try {
      activeChat.value = await window.api.chats.get(chatId)
      if (activeChat.value.modelId) {
        selectedModelId.value = activeChat.value.modelId
      }
    } catch {
      activeChat.value = null
    }
  }

  const generateOpeningForChat = async (chatId: string) => {
    const chat =
      activeChat.value?.id === chatId ? activeChat.value : await window.api.chats.get(chatId)

    if (chat.messages.some((message) => message.role === 'assistant')) return
    if (!chat.character?.greeting?.trim()) return

    error.value = null

    try {
      await window.api.chat.generateOpening(chatId)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to add opening message'
    } finally {
      if (activeChat.value?.id === chatId) {
        activeChat.value = await window.api.chats.get(chatId)
      }
      await refreshChats()
    }
  }

  const appendStreaming = (delta: string) => {
    streamingText.value += delta
    thinkingText.value = ''
  }

  const appendThinking = (delta: string) => {
    thinkingText.value += delta
  }

  const clearThinking = () => {
    thinkingText.value = ''
  }

  const commitStreaming = (): Message | null => {
    if (!activeChat.value || !streamingText.value) return null
    const message: Message = {
      id: crypto.randomUUID(),
      chatId: activeChat.value.id,
      role: 'assistant',
      content: streamingText.value,
      createdAt: Date.now()
    }
    activeChat.value.messages.push(message)
    streamingText.value = ''
    thinkingText.value = ''
    return message
  }

  const addUserMessage = (content: string) => {
    if (!activeChat.value) return
    activeChat.value.messages.push({
      id: crypto.randomUUID(),
      chatId: activeChat.value.id,
      role: 'user',
      content,
      createdAt: Date.now()
    })
  }

  return {
    characters,
    personas,
    chats,
    activeChat,
    llmStatus,
    models,
    selectedModelId,
    selectedModel,
    streamingText,
    thinkingText,
    isGenerating,
    error,
    uiState,
    refreshCharacters,
    refreshPersonas,
    refreshChats,
    refreshLlm,
    loadUiState,
    persistUiState,
    setSidebarCollapsed,
    toggleSidebarCollapsed,
    toggleSidebarSection,
    toggleTheme,
    isDarkTheme,
    refreshData,
    refreshAll,
    loadChat,
    createChatForCharacter,
    generateOpeningForChat,
    finishGeneration,
    handleChatDeleted,
    handleGenerationCancelled,
    appendStreaming,
    appendThinking,
    clearThinking,
    commitStreaming,
    addUserMessage
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAppStore, import.meta.hot))
}
