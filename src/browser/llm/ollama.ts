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
  /** '' when transport is 'relay' — amallo stamps its own bearer token on
   * relay-originated requests; web never holds it (see relay/dispatch.rs). */
  apiKey: string
}

let cachedConnection: OllamaConnection | null = null

export type OllamaProbeResult = 'ok' | 'unauthorized' | 'unreachable'

const TAGS_TTL_MS = 45_000

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
 * True when the configured connection targets an amallo instance rather
 * than a plain Ollama — either transport is 'relay' (amallo is
 * necessarily on the other end of a relay pairing), or a bearer token is
 * set (the direct/LAN amallo path, which still requires one).
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
      const res = await httpFetch(conn)(`${conn.baseUrl}/api/tags`, {
        headers: buildHeaders(conn),
        signal: AbortSignal.timeout(force ? 10_000 : 2000)
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

export const probeOllama = async (options: { force?: boolean } = {}): Promise<OllamaProbeResult> => {
  return (await fetchTags(options)).probe
}

const DEFAULT_CONTEXT_TOKENS = 8192

const modelContextCache = new Map<string, number>()

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

export const getModelContextLength = async (modelId: string): Promise<number> => {
  const cached = modelContextCache.get(modelId)
  if (cached !== undefined) return cached

  try {
    const conn = await resolveConnection()
    const res = await httpFetch(conn)(`${conn.baseUrl}/api/show`, {
      method: 'POST',
      headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: modelId })
    })
    if (!res.ok) {
      modelContextCache.set(modelId, DEFAULT_CONTEXT_TOKENS)
      return DEFAULT_CONTEXT_TOKENS
    }

    const data = (await res.json()) as ShowResponse
    const contextLength = parseContextLength(data) ?? DEFAULT_CONTEXT_TOKENS
    modelContextCache.set(modelId, contextLength)
    return contextLength
  } catch {
    modelContextCache.set(modelId, DEFAULT_CONTEXT_TOKENS)
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
    return
  }
  modelContextCache.clear()
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
  if (
    typeof chunk.completed === 'number' &&
    typeof chunk.total === 'number' &&
    chunk.total > 0
  ) {
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

let activeAbortController: AbortController | null = null

export const abortChat = (): void => {
  activeAbortController?.abort()
  activeAbortController = null
}

export const chat = async (
  params: ChatParams,
  onToken: (token: string) => void,
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

  const conn = await resolveConnection()
  const res = await httpFetch(conn)(`${conn.baseUrl}/api/chat`, {
    method: 'POST',
    headers: buildHeaders(conn, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Ollama chat failed: ${body || res.statusText}`)
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
        const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
        const delta = chunk.message?.content ?? ''
        if (delta) onToken(delta)
      }
    }

    if (buffer.trim()) {
      const chunk = JSON.parse(buffer) as { message?: { content?: string } }
      const delta = chunk.message?.content ?? ''
      if (delta) onToken(delta)
    }
  } finally {
    activeAbortController = null
  }
}
