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
  /**
   * How long Ollama keeps the model loaded after a reply (maps to keep_alive).
   * Minutes when positive; 0 unloads immediately; -1 keeps loaded indefinitely.
   */
  keepAliveMinutes?: number
  /**
   * "Story so far" for the turns that are no longer sent verbatim. A long
   * chat otherwise sends every message every turn, which grows without
   * bound: the prompt fills the model's context, replies get squeezed into
   * what is left, and each turn costs a full re-read of the history.
   *
   * The messages it covers are never deleted — this is a prompt-building
   * artifact, so clearing it restores the raw history.
   */
  summary?: string
  /** Id of the last message the summary covers. Everything after it is
   * still sent verbatim. */
  summarizedThrough?: string
  /** When the summary was last rebuilt. */
  summarizedAt?: number
}

export interface ChatSettingsInput {
  personaId?: string
  systemPrompt?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  contextWindowSize?: number
  keepAliveMinutes?: number
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
  /** True when generation stopped early due to a transport error (a
   * dropped relay/network connection mid-stream) rather than the model
   * finishing normally — see chat-generation.ts's PartialGenerationError.
   * The existing regenerate action retries it like any other message. */
  truncated?: boolean
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

/** `displaced`: another tab or device took this pairing over. The relay
 * keeps one client per pair, so this side stands down instead of taking it
 * straight back (spec §8) and waits for the user to reclaim it. */
export type RelayState = 'connecting' | 'waiting' | 'online' | 'offline' | 'displaced' | 'closed'

export interface LLMStatus {
  ollamaAvailable: boolean
  /** True when connected via an Amallo instance (API key set, or relay
   * paired) rather than plain Ollama. */
  usingAmallo: boolean
  /** What the user named the Amallo instance on the other end of the
   * active relay pairing, so the UI can say "Mac connected" rather than
   * the generic "Amallo connected". Null when there is no pairing behind
   * the connection (plain Ollama, or the direct/LAN Amallo path). */
  amalloLabel: string | null
  /** True when the server answered 401 — the URL is reachable but the API key is missing/wrong */
  unauthorized: boolean
  transport: 'direct' | 'relay'
  /** Only meaningful when transport is 'relay'; null otherwise (including
   * "no pairing configured" — distinct from 'offline', which means a
   * pairing exists but the agent isn't currently reachable). */
  relayState: RelayState | null
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
  /** Bearer token sent as `Authorization: Bearer <key>` (e.g. an Amallo API key). Empty = no auth header. */
  ollamaApiKey: string
  /** Id of the currently active row in the `pairings` IndexedDB store (see
   * db/pairings.ts) — the relay URL/pair id/PSK indirection all live there
   * now, since a user can have several saved pairings. Empty = no pairing. */
  activePairingId: string
}

/** One saved Relay pairing (a QR-scanned Amallo instance). Stored in the
 * `pairings` IndexedDB store, keyed by `id`; see db/pairings.ts. */
export interface StoredPairing {
  id: string
  /** User-editable display name, e.g. "Home PC". Defaults to the relay
   * URL's hostname when not given at pairing time. */
  label: string
  /** The relay's base URL from the pairing QR/code, e.g. "wss://relay.opencharui.com". */
  relayUrl: string
  /** 16-byte pair_id, base64url — not secret on its own (spec §9: it's a
   * connectivity capability, not what confidentiality depends on), so it's
   * safe to store as plain JSON alongside the other fields. */
  pairId: string
  /** Looks up the paired PSK in the `relaySecrets` IndexedDB store (see
   * db/relay-secrets.ts) — the raw key bytes never live in this row, only
   * this indirection. */
  pskId: string
  addedAt: number
}

/** Summary of a saved pairing for the settings UI's list — no live
 * connection state (that's only meaningful for the active one; see
 * `relay.getStatus()`). */
export interface RelayPairingSummary {
  id: string
  label: string
  relayUrl: string
  active: boolean
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

/**
 * Reasoning deltas from a thinking model — Ollama streams these as
 * `message.thinking`, separately from `message.content`, and they are not
 * part of the reply. Carried so the UI can show that generation is under
 * way; never persisted, and never sent back as history.
 */
export interface ChatThinkingEvent {
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
