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
  RelayPairingSummary,
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
    /** Every saved pairing, in the order they were added. */
    list(): Promise<RelayPairingSummary[]>
    /** Whether a pairing is active and, if so, its id/label/relay URL and
     * live connection state (null while not yet connected). */
    getStatus(): Promise<{
      paired: boolean
      activeId: string
      relayUrl: string
      label: string
      state: RelayState | null
    }>
    /** Parses a scanned/pasted `opencharui://pair?...` code and saves it as
     * a new pairing (or refreshes an existing one for the same relay
     * URL/pair id), makes it active, and connects. `label` names the
     * pairing; when omitted it defaults to the relay URL's hostname. */
    add(code: string, label?: string): Promise<void>
    /** Switches the active pairing and connects to it. */
    setActive(id: string): Promise<void>
    rename(id: string, label: string): Promise<void>
    /** Removes a saved pairing. If it was active, another saved pairing (if
     * any) is promoted to active. */
    remove(id: string): Promise<void>
    /** Reclaim a pairing that another tab or device took over. */
    reconnect(): Promise<void>
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
    setVariation(chatId: string, messageId: string, direction: 'prev' | 'next'): Promise<Message>
    editLastUserMessage(chatId: string, content: string): Promise<Message>
    editLastAssistantMessage(chatId: string, content: string): Promise<Message>
    deleteMessage(chatId: string, messageId: string): Promise<void>
    /** Rebuild the rolling summary from the whole history. Resolves null
     * when the chat is too short to be worth compacting. */
    rebuildSummary(chatId: string): Promise<{ folded: number; keptVerbatim: number } | null>
    /** Drop the summary; the chat goes back to sending history verbatim. */
    clearSummary(chatId: string): Promise<void>
    saveSummary(chatId: string, summary: string, summarizedThrough: string): Promise<void>
    abort(chatId: string): Promise<void>
    onChunk(callback: (event: { chatId: string; delta: string }) => void): () => void
    onThinking(callback: (event: { chatId: string; delta: string }) => void): () => void
    onDone(callback: (event: { chatId: string; messageId: string }) => void): () => void
    onError(callback: (event: { chatId: string; error: string }) => void): () => void
    onCancelled(callback: (event: { chatId: string }) => void): () => void
  }
}
