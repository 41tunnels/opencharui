export type MessageRole = 'system' | 'user' | 'assistant'

export interface CharacterPersonality {
  traits?: string[]
  speakingStyle?: string
}

export interface CharacterDefaultParams {
  temperature?: number
  topP?: number
  maxTokens?: number
}

export interface Character {
  id: string
  name: string
  avatar?: string
  description?: string
  personality?: CharacterPersonality
  scenario?: string
  greeting?: string
  defaultParams?: CharacterDefaultParams
}

export interface CharacterSummary {
  id: string
  name: string
  avatar?: string
  description?: string
  updatedAt: number
}

export interface Persona {
  id: string
  name: string
  description?: string
}

export interface PersonaSummary {
  id: string
  name: string
  description?: string
  updatedAt: number
}

export interface Chat {
  id: string
  characterId: string
  personaId?: string
  title: string
  modelId: string | null
  provider: 'ollama' | null
  createdAt: number
  updatedAt: number
  /** Timestamp of the most recent message, when the chat has messages */
  lastMessageAt?: number
  /** Appended after the global system prompt for this chat when set */
  systemPrompt?: string
  /** Overrides character defaultParams when set */
  temperature?: number
  topP?: number
  /** Maps to Ollama num_predict when set */
  maxTokens?: number
  /** Number of user/assistant message pairs sent as history */
  contextWindowSize?: number
}

export interface ChatSettingsInput {
  personaId?: string
  systemPrompt?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  contextWindowSize?: number
}

export interface ChatSummary extends Chat {
  characterName?: string
  personaName?: string
}

export interface Message {
  id: string
  chatId: string
  role: MessageRole
  /** Active variation text shown in the chat */
  content: string
  /** All stored variants for assistant messages */
  variations?: string[]
  activeVariationIndex?: number
  createdAt: number
}

export interface ChatWithMessages extends Chat {
  messages: Message[]
  character?: Character
  persona?: Persona
}

export interface ModelInfo {
  id: string
  name: string
  source: 'ollama'
  sizeBytes?: number
}

export interface LLMStatus {
  ollamaAvailable: boolean
  /** True when connected via an amallo instance (API key set) rather than plain Ollama. */
  usingAmallo: boolean
  /** True when the server answered 401 — the URL is reachable but the API key is missing/wrong */
  unauthorized: boolean
}

export interface ModelPullProgress {
  status: string
  completed?: number
  total?: number
  percent?: number
}

export type SyncState = 'disabled' | 'unsupported' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  state: SyncState
  /** Epoch ms of the last successful sync, or null if never. */
  lastSyncedAt: number | null
  /** Human-readable error when state is 'error'. */
  error?: string
}

export type ModelNotes = Record<string, string>

export interface AppSettings {
  systemPrompt: string
  /** When empty, dev uses the Vite proxy at /ollama; production uses http://127.0.0.1:11434 */
  ollamaUrl: string
  /** Bearer token sent as `Authorization: Bearer <key>` (e.g. an amallo API key). Empty = no auth header. */
  ollamaApiKey: string
}

export type AppTheme = 'light' | 'dark'

export interface AppUiState {
  sidebarCollapsed: boolean
  sidebarSections: {
    characters: boolean
    personas: boolean
    chats: boolean
  }
  theme: AppTheme
}

export const DEFAULT_UI_STATE: AppUiState = {
  sidebarCollapsed: false,
  sidebarSections: {
    characters: true,
    personas: true,
    chats: true
  },
  theme: 'light'
}

export interface ChatChunkEvent {
  chatId: string
  delta: string
}

export interface ChatDoneEvent {
  chatId: string
  messageId: string
}

export interface ChatErrorEvent {
  chatId: string
  error: string
}

export interface ChatCancelledEvent {
  chatId: string
}
