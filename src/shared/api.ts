import type {
  AppSettings,
  AppUiState,
  Character,
  CharacterSummary,
  ChatSummary,
  ChatWithMessages,
  ChatSettingsInput,
  LLMStatus,
  Message,
  ModelInfo,
  ModelNotes,
  ModelPullProgress,
  Persona,
  PersonaSummary,
  RelayState,
  SyncStatus
} from '@shared/types'
import type { ChatSaveInput } from '@shared/chat-schema'

export interface OpenCharUiApi {
  characters: {
    list(): Promise<CharacterSummary[]>
    get(id: string): Promise<Character>
    save(character: Character): Promise<void>
    delete(id: string): Promise<void>
    import(): Promise<Character | null>
    export(id: string): Promise<boolean>
  }
  personas: {
    list(): Promise<PersonaSummary[]>
    get(id: string): Promise<Persona>
    save(persona: Persona): Promise<void>
    delete(id: string): Promise<void>
    import(): Promise<Persona | null>
    export(id: string): Promise<boolean>
  }
  chats: {
    list(): Promise<ChatSummary[]>
    get(id: string): Promise<ChatWithMessages>
    create(characterId: string, personaId?: string): Promise<ChatWithMessages>
    save(chat: ChatSaveInput): Promise<ChatWithMessages>
    import(data: unknown): Promise<ChatWithMessages>
    delete(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    setModel(id: string, modelId: string, provider: 'ollama'): Promise<void>
    saveSettings(id: string, settings: ChatSettingsInput): Promise<ChatWithMessages>
  }
  llm: {
    getStatus(): Promise<LLMStatus>
    listModels(): Promise<ModelInfo[]>
    /** One /api/tags round-trip; returns status + models. */
    refresh(options?: { force?: boolean }): Promise<{ status: LLMStatus; models: ModelInfo[] }>
    getModelContextLength(modelId: string): Promise<number>
    pullModel(
      name: string,
      onProgress: (progress: ModelPullProgress) => void,
      signal?: AbortSignal
    ): Promise<void>
    deleteModel(name: string): Promise<void>
  }
  modelNotes: {
    getAll(): Promise<ModelNotes>
    set(modelId: string, note: string): Promise<void>
    delete(modelId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    save(settings: Partial<AppSettings>): Promise<AppSettings>
  }
  relay: {
    /** Whether pairing settings exist and, if so, the relay URL and live
     * connection state (null while not yet connected). */
    getStatus(): Promise<{ paired: boolean; relayUrl: string; state: RelayState | null }>
    /** Parses a scanned/pasted `opencharui://pair?...` code, persists it,
     * and connects — replacing any previous pairing. */
    pair(code: string): Promise<void>
    unpair(): Promise<void>
    onStatusChanged(callback: (state: RelayState | null) => void): () => void
  }
  sync: {
    now(): Promise<SyncStatus>
    getStatus(): SyncStatus
    onStatusChanged(callback: (status: SyncStatus, appliedRemote: boolean) => void): () => void
  }
  ui: {
    get(): Promise<AppUiState>
    save(state: Partial<AppUiState>): Promise<AppUiState>
  }
  chat: {
    send(chatId: string, content: string): Promise<void>
    generateOpening(chatId: string): Promise<void>
    regenerateLast(chatId: string): Promise<void>
    setVariation(
      chatId: string,
      messageId: string,
      direction: 'prev' | 'next'
    ): Promise<Message>
    editLastUserMessage(chatId: string, content: string): Promise<Message>
    editLastAssistantMessage(chatId: string, content: string): Promise<Message>
    deleteMessage(chatId: string, messageId: string): Promise<void>
    abort(chatId: string): Promise<void>
    onChunk(callback: (event: { chatId: string; delta: string }) => void): () => void
    onDone(callback: (event: { chatId: string; messageId: string }) => void): () => void
    onError(callback: (event: { chatId: string; error: string }) => void): () => void
    onCancelled(callback: (event: { chatId: string }) => void): () => void
  }
}
