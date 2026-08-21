import type { ModelInfo, ModelPullProgress } from '@shared/types'
import { getSettings } from '../db/settings'
import { isRelayConfigured, relayFetch } from '../relay'
import { ensureRelayConfigured } from '../relay/pairing'

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEV_OLLAMA_PROXY = '/ollama'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Picks the transport per connection: relay requests are multiplexed
 * over one WebSocket (see `browser/relay/fetch.ts`) rather than opening a
 * real socket per call, but every call site below is unaware of the
 * difference — both return a real `Response` with a real streamable body. */
export const httpFetch = (conn: OllamaConnection): FetchLike =>
  conn.transport === 'relay' ? (relayFetch as FetchLike) : fetch

export interface ChatParams {
  modelId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Ollama keep_alive: duration string (e.g. "5m"), seconds, 0, or -1 */
  keepAlive?: string | number
}

export interface OllamaConnection {
  transport: 'direct' | 'relay'
  /** '' when transport is 'relay' — relayFetch resolves paths against the
   * relay session, not a real origin. */
  baseUrl: string
  /** '' when transport is 'relay' — Amallo stamps its own bearer token on
   * relay-originated requests; web never holds it (see relay/dispatch.rs). */
  apiKey: string
}

let cachedConnection: OllamaConnection | null = null

export type OllamaProbeResult = 'ok' | 'unauthorized' | 'unreachable'

const TAGS_TTL_MS = 45_000

/** How long `/api/tags` gets before it is called unreachable, per
 * transport.
 *
 * A direct probe is a request to 127.0.0.1 and should fail fast — two
 * seconds is already generous for a local socket. A relay probe is not
 * comparable: on a fresh page load it has to open a WebSocket to the
 * relay, exchange hello, wait for the agent's `peer_online` and complete
 * a two-round-trip E2E handshake before the request itself even starts.
 * Holding that to the same two seconds is what put "Waiting for Ollama"
 * in front of a pairing that was a few hundred milliseconds from being
 * ready, and it is why connecting appeared to need several attempts —
 * each attempt was abandoned just before it would have succeeded. */
const PROBE_TIMEOUT_MS: Record<OllamaConnection['transport'], number> = {
  direct: 2_000,
  relay: 8_000
}

/** The budget for an explicit "check connection" — the user is watching
 * and has asked for a definitive answer, so it is worth waiting for. */
const FORCED_PROBE_TIMEOUT_MS: Record<OllamaConnection['transport'], number> = {
  direct: 10_000,
  relay: 20_000
}

type TagsResponse = {
  models: Array<{ name: string; size: number }>
}

interface TagsSnapshot {
  fetchedAt: number
  probe: OllamaProbeResult
  models: ModelInfo[]
}

let tagsSnapshot: TagsSnapshot | null = null
let tagsInFlight: Promise<TagsSnapshot> | null = null

export const clearTagsCache = (): void => {
  tagsSnapshot = null
}

export const invalidateOllamaBaseUrl = (): void => {
  cachedConnection = null
  clearModelContextCache()
  clearTagsCache()
  tagsInFlight = null
}

const normalizeOllamaUrl = (url: string): string => url.replace(/\/+$/, '')

// Shared by the LLM client and the sync engine (browser/sync/engine.ts) so both hit the same
// base URL with the same auth headers (and honour the settings-save cache reset).
export const resolveConnection = async (): Promise<OllamaConnection> => {
  if (cachedConnection) return cachedConnection

  const { ollamaUrl, ollamaApiKey } = await getSettings()
  const apiKey = ollamaApiKey.trim()
  const custom = ollamaUrl.trim()

  // An explicit direct URL always wins, even with a relay paired — needed
  // for LAN access and for debugging against a raw Ollama instance.
  if (custom) {
    cachedConnection = { transport: 'direct', baseUrl: normalizeOllamaUrl(custom), apiKey }
    return cachedConnection
  }

  if (!isRelayConfigured()) await ensureRelayConfigured()
  if (isRelayConfigured()) {
    cachedConnection = { transport: 'relay', baseUrl: '', apiKey: '' }
    return cachedConnection
  }

  cachedConnection = {
    transport: 'direct',
    baseUrl: import.meta.env.DEV ? DEV_OLLAMA_PROXY : DEFAULT_OLLAMA_URL,
    apiKey
  }
  return cachedConnection
}

export const buildHeaders = (
  { apiKey }: OllamaConnection,
  extra?: Record<string, string>
): Record<string, string> => ({
  ...(extra ?? {}),
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
})

/**
 * True when the configured connection targets an Amallo instance rather
 * than a plain Ollama — either transport is 'relay' (Amallo is
 * necessarily on the other end of a relay pairing), or a bearer token is
 * set (the direct/LAN Amallo path, which still requires one).
 */
export const isUsingAmallo = async (): Promise<boolean> => {
  const conn = await resolveConnection()
  return conn.transport === 'relay' || conn.apiKey.length > 0
}

const mapTagsModels = (data: TagsResponse): ModelInfo[] =>
  data.models.map((m) => ({
    id: m.name,
    name: m.name,
    source: 'ollama' as const,
    sizeBytes: m.size
  }))

/** Single /api/tags fetch shared by probe + listModels, with TTL and in-flight dedupe. */
export const fetchTags = async (options: { force?: boolean } = {}): Promise<TagsSnapshot> => {
  const force = options.force ?? false
  if (!force && tagsSnapshot && Date.now() - tagsSnapshot.fetchedAt < TAGS_TTL_MS) {
    return tagsSnapshot
  }
  if (!force && tagsInFlight) return tagsInFlight

  const request = (async (): Promise<TagsSnapshot> => {
    try {
      const conn = await resolveConnection()
      const budget = force ? FORCED_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS
      const res = await httpFetch(conn)(`${conn.baseUrl}/api/tags`, {
        headers: buildHeaders(conn),
        signal: AbortSignal.timeout(budget[conn.transport])
      })

      if (!res.ok) {
        return {
          fetchedAt: Date.now(),
          probe: res.status === 401 ? 'unauthorized' : 'unreachable',
          models: []
        }
      }

      const data = (await res.json()) as TagsResponse
      return {
        fetchedAt: Date.now(),
        probe: 'ok',
        models: mapTagsModels(data)
      }
    } catch {
      // Short TTL so soft refresh retries soon after a transient failure.
      return {
        fetchedAt: Date.now() - TAGS_TTL_MS + 5_000,
        probe: 'unreachable',
        models: []
      }
    }
  })()

  tagsInFlight = request
  try {
    const snapshot = await request
    // Keep the newest snapshot if a forced fetch raced ahead of a soft one.
    if (!tagsSnapshot || snapshot.fetchedAt >= tagsSnapshot.fetchedAt) {
      tagsSnapshot = snapshot
    }
    return tagsSnapshot ?? snapshot
  } finally {
    if (tagsInFlight === request) tagsInFlight = null
  }
}

export const probeOllama = async (
  options: { force?: boolean } = {}
): Promise<OllamaProbeResult> => {
  return (await fetchTags(options)).probe
}

const DEFAULT_CONTEXT_TOKENS = 8192

const modelContextCache = new Map<string, number>()
/** When each cached value was read from `/api/ps`. Ollama re-sizes a
 * model's window as it reloads — this machine went from 32768 to 65536
 * mid-session — so a value cached for the whole session is a value that
 * quietly goes wrong. */
const loadedContextFetchedAt = new Map<string, number>()
const LOADED_CONTEXT_TTL_MS = 30_000

type ShowResponse = {
  model_info?: Record<string, unknown>
  parameters?: string
}

const parseContextLength = (data: ShowResponse): number | null => {
  if (data.model_info) {
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
        return value
      }
    }
  }

  if (data.parameters) {
    const match = data.parameters.match(/num_ctx\s+(\d+)/)
    if (match) {
      const parsed = Number.parseInt(match[1] ?? '', 10)
      if (parsed > 0) return parsed
    }
  }

  return null
}

type PsResponse = {
  models?: Array<{ name?: string; model?: string; context_length?: number }>
}

/**
 * The context window the model is *actually loaded with*, which is not the
 * one `/api/show` reports: that is the architecture's maximum (262144 for
 * gemma4), while Ollama loads the model with its own, far smaller window
 * unless told otherwise. Sizing anything against the architectural number
 * means the prompt is allowed to grow until it fills the real window, and
 * the reply gets whatever few tokens are left — `done_reason: "length"`
 * after 200 tokens, cut off mid-sentence.
 *
 * Only a loaded model appears here, so this returns null until the first
 * generation has loaded it; the caller falls back to `/api/show` and
 * re-checks next time rather than caching a value that is likely wrong.
 */
const fetchLoadedContextLength = async (modelId: string): Promise<number | null> => {
  try {
    const conn = await resolveConnection()
    const res = await httpFetch(conn)(`${conn.baseUrl}/api/ps`, { headers: buildHeaders(conn) })
    if (!res.ok) return null
    const data = (await res.json()) as PsResponse
    const entry = data.models?.find((m) => m.name === modelId || m.model === modelId)
    const loaded = entry?.context_length
    return typeof loaded === 'number' && loaded > 0 ? loaded : null
  } catch {
    return null
  }
}

export const getModelContextLength = async (modelId: string): Promise<number> => {
  const cached = modelContextCache.get(modelId)
  if (
    cached !== undefined &&
    Date.now() - (loadedContextFetchedAt.get(modelId) ?? 0) < LOADED_CONTEXT_TTL_MS
  ) {
    return cached
  }

  const loaded = await fetchLoadedContextLength(modelId)
  if (loaded !== null) {
    modelContextCache.set(modelId, loaded)
    loadedContextFetchedAt.set(modelId, Date.now())
    return loaded
  }

  // Nothing below is cached: these are the values used while the model is
  // not loaded, and the loaded window above supersedes them as soon as it
  // exists. Caching here would pin the architectural maximum for the rest
  // of the session, which is the number that caused the truncation.
  try {
    const conn = await resolveConnection()
    const res = await httpFetch(conn)(`${conn.baseUrl}/api/show`, {
      method: 'POST',
      headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: modelId })
    })
    if (!res.ok) return DEFAULT_CONTEXT_TOKENS

    const data = (await res.json()) as ShowResponse
    return parseContextLength(data) ?? DEFAULT_CONTEXT_TOKENS
  } catch {
    return DEFAULT_CONTEXT_TOKENS
  }
}

export const listModels = async (options: { force?: boolean } = {}): Promise<ModelInfo[]> => {
  const snapshot = await fetchTags(options)
  if (snapshot.probe !== 'ok') return []
  return snapshot.models
}

export const getDefaultModelId = async (): Promise<string | null> => {
  const models = await listModels()
  return models[0]?.id ?? null
}

export const clearModelContextCache = (modelId?: string): void => {
  if (modelId) {
    modelContextCache.delete(modelId)
    loadedContextFetchedAt.delete(modelId)
    return
  }
  modelContextCache.clear()
  loadedContextFetchedAt.clear()
}

type PullResponse = {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

const mapPullProgress = (chunk: PullResponse): ModelPullProgress => {
  const progress: ModelPullProgress = { status: chunk.status }
  if (typeof chunk.completed === 'number') progress.completed = chunk.completed
  if (typeof chunk.total === 'number') progress.total = chunk.total
  if (typeof chunk.completed === 'number' && typeof chunk.total === 'number' && chunk.total > 0) {
    progress.percent = Math.min(100, Math.round((chunk.completed / chunk.total) * 100))
  }
  return progress
}

export const pullModel = async (
  name: string,
  onProgress: (progress: ModelPullProgress) => void,
  signal?: AbortSignal
): Promise<void> => {
  const conn = await resolveConnection()
  const res = await httpFetch(conn)(`${conn.baseUrl}/api/pull`, {
    method: 'POST',
    headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, stream: true }),
    signal
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Failed to pull model: ${body || res.statusText}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        const chunk = JSON.parse(line) as PullResponse
        if (chunk.error) throw new Error(chunk.error)
        onProgress(mapPullProgress(chunk))
        if (chunk.status === 'success') {
          clearTagsCache()
          return
        }
      }
    }

    if (buffer.trim()) {
      const chunk = JSON.parse(buffer) as PullResponse
      if (chunk.error) throw new Error(chunk.error)
      onProgress(mapPullProgress(chunk))
      if (chunk.status !== 'success') {
        throw new Error(`Model pull ended unexpectedly: ${chunk.status}`)
      }
    }
    clearTagsCache()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw err
  }
}

export const deleteModel = async (name: string): Promise<void> => {
  const conn = await resolveConnection()
  const res = await httpFetch(conn)(`${conn.baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Failed to delete model: ${body || res.statusText}`)
  }

  clearModelContextCache(name)
  clearTagsCache()
}

type ChatStreamChunk = {
  message?: { content?: string; thinking?: string }
  done?: boolean
}

const emitChunk = (chunk: ChatStreamChunk, callbacks: ChatStreamCallbacks): void => {
  const thinking = chunk.message?.thinking ?? ''
  if (thinking) callbacks.onThinking?.(thinking)
  const delta = chunk.message?.content ?? ''
  if (delta) callbacks.onToken(delta)
}

let activeAbortController: AbortController | null = null

export const abortChat = (): void => {
  activeAbortController?.abort()
  activeAbortController = null
}

/**
 * Posts to `/api/chat`, asking for thinking to be off.
 *
 * `num_predict` is a budget for reasoning *and* reply together, so a
 * thinking model can spend all of it reasoning and return an empty
 * message — which is exactly what a character card plus a few turns of
 * history produced at the default 512. A roleplay reply gains nothing from
 * chain-of-thought. Some Ollama builds reject `think` for models that do
 * not support it, so a rejection naming it retries once without the field:
 * a message must not fail over an optimisation.
 */
const postChat = async (body: object, signal?: AbortSignal): Promise<Response> => {
  const conn = await resolveConnection()
  const post = (payload: object): Promise<Response> =>
    httpFetch(conn)(`${conn.baseUrl}/api/chat`, {
      method: 'POST',
      headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal
    })

  const res = await post({ ...body, think: false })
  if (res.ok) return res

  const detail = await res.text().catch(() => '')
  if (/think/i.test(detail)) {
    const retried = await post(body)
    if (retried.ok) return retried
    const retryDetail = await retried.text().catch(() => retried.statusText)
    throw new Error(`Ollama chat failed: ${retryDetail || retried.statusText}`)
  }
  throw new Error(`Ollama chat failed: ${detail || res.statusText}`)
}

/**
 * One non-streaming completion, used for work the user is not watching —
 * summarising a chat's older turns, for instance. Deliberately does not
 * touch `activeAbortController`: that belongs to the reply the user *is*
 * watching, and Stop must not be answered by cancelling background work
 * instead (nor background work by cancelling the reply).
 */
export const complete = async (params: ChatParams, signal?: AbortSignal): Promise<string> => {
  const res = await postChat(
    {
      model: params.modelId,
      messages: params.messages,
      stream: false,
      ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      options: {
        temperature: params.temperature,
        top_p: params.topP,
        num_predict: params.maxTokens
      }
    },
    signal
  )
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content?.trim() ?? ''
}

export interface ChatStreamCallbacks {
  /** Visible reply text (Ollama's `message.content`). */
  onToken: (token: string) => void
  /**
   * Reasoning text (Ollama's `message.thinking`), which a thinking model
   * streams *before* any content — often for many seconds, with
   * `content` empty the whole time. Reading only `content` made those
   * models look like they had hung, and a generation that stopped before
   * the reasoning finished produced a silently empty reply.
   */
  onThinking?: (delta: string) => void
}

export const chat = async (
  params: ChatParams,
  callbacks: ChatStreamCallbacks,
  externalSignal?: AbortSignal
): Promise<void> => {
  activeAbortController = new AbortController()
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, activeAbortController.signal])
    : activeAbortController.signal

  const body = {
    model: params.modelId,
    messages: params.messages,
    stream: true,
    ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
    options: {
      temperature: params.temperature,
      top_p: params.topP,
      num_predict: params.maxTokens
    }
  }

  console.log('[Ollama] POST /api/chat', body)

  const res = await postChat(body, signal)
  if (!res.body) {
    throw new Error('Ollama chat failed: response had no body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        emitChunk(JSON.parse(line) as ChatStreamChunk, callbacks)
      }
    }

    if (buffer.trim()) {
      emitChunk(JSON.parse(buffer) as ChatStreamChunk, callbacks)
    }
  } finally {
    activeAbortController = null
  }
}
