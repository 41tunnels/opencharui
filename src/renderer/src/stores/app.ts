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
    unauthorized: false
  })
  const models = ref<ModelInfo[]>([])
  const selectedModelId = ref<string | null>(null)
  const streamingText = ref('')
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

  const refreshLlm = async () => {
    llmStatus.value = await window.api.llm.getStatus()
    models.value = await window.api.llm.listModels()
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

  const toggleSidebarCollapsed = () => {
    const sidebarCollapsed = !uiState.value.sidebarCollapsed
    uiState.value = { ...uiState.value, sidebarCollapsed }
    void persistUiState({ sidebarCollapsed })
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

  const refreshData = async () => {
    await Promise.all([refreshCharacters(), refreshPersonas(), refreshChats(), refreshLlm()])
    if (activeChat.value) {
      await loadChat(activeChat.value.id)
    }
  }

  const refreshAll = async () => {
    await Promise.all([refreshData(), loadUiState({ syncTheme: false })])
  }

  const loadChat = async (chatId: string) => {
    activeChat.value = await window.api.chats.get(chatId)
    if (activeChat.value.modelId) {
      selectedModelId.value = activeChat.value.modelId
    }
    streamingText.value = ''
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
  }

  const handleChatDeleted = (chatId: string) => {
    if (activeChat.value?.id === chatId) {
      activeChat.value = null
    }
    isGenerating.value = false
    streamingText.value = ''
    error.value = null
  }

  const handleGenerationCancelled = async (chatId: string) => {
    if (activeChat.value?.id !== chatId) return

    isGenerating.value = false
    streamingText.value = ''

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
    isGenerating,
    error,
    uiState,
    refreshCharacters,
    refreshPersonas,
    refreshChats,
    refreshLlm,
    loadUiState,
    persistUiState,
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
    commitStreaming,
    addUserMessage
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAppStore, import.meta.hot))
}
