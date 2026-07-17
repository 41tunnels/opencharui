import type { ModelInfo, ModelPullProgress } from '@shared/types'
import { getSettings } from '../db/settings'

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEV_OLLAMA_PROXY = '/ollama'

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
  baseUrl: string
  apiKey: string
}

let cachedConnection: OllamaConnection | null = null

export const invalidateOllamaBaseUrl = (): void => {
  cachedConnection = null
  clearModelContextCache()
}

const normalizeOllamaUrl = (url: string): string => url.replace(/\/+$/, '')

// Shared by the LLM client and the device-sync engine so both hit the same
// base URL with the same auth headers (and honour the settings-save cache reset).
export const resolveConnection = async (): Promise<OllamaConnection> => {
  if (cachedConnection) return cachedConnection

  const { ollamaUrl, ollamaApiKey } = await getSettings()
  const apiKey = ollamaApiKey.trim()
  const custom = ollamaUrl.trim()
  if (custom) {
    cachedConnection = { baseUrl: normalizeOllamaUrl(custom), apiKey }
    return cachedConnection
  }

  cachedConnection = {
    baseUrl: import.meta.env.DEV ? DEV_OLLAMA_PROXY : DEFAULT_OLLAMA_URL,
    apiKey
  }
  return cachedConnection
}

// Custom headers force a CORS preflight and must be allowlisted by the server,
// so ngrok-skip-browser-warning (bypasses ngrok's free-tier interstitial) is
// only sent to ngrok hosts — plain Ollama rejects preflights that request it.
const isNgrokHost = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.includes('ngrok')
  } catch {
    return false
  }
}

export const buildHeaders = (
  { baseUrl, apiKey }: OllamaConnection,
  extra?: Record<string, string>
): Record<string, string> => ({
  ...(extra ?? {}),
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  ...(apiKey && isNgrokHost(baseUrl) ? { 'ngrok-skip-browser-warning': 'true' } : {})
})

export type OllamaProbeResult = 'ok' | 'unauthorized' | 'unreachable'

/**
 * True when the configured connection targets an amallo instance rather than a
 * plain Ollama — inferred from an API key being set (amallo requires a bearer
 * token; a direct Ollama connection has none).
 */
export const isUsingAmallo = async (): Promise<boolean> => {
  const { apiKey } = await resolveConnection()
  return apiKey.length > 0
}

export const probeOllama = async (): Promise<OllamaProbeResult> => {
  try {
    const { baseUrl, apiKey } = await resolveConnection()
    const res = await fetch(`${baseUrl}/api/tags`, {
      headers: buildHeaders({ baseUrl, apiKey }),
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) return 'ok'
    return res.status === 401 ? 'unauthorized' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

type TagsResponse = {
  models: Array<{ name: string; size: number }>
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
    const { baseUrl, apiKey } = await resolveConnection()
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: buildHeaders({ baseUrl, apiKey }, { 'Content-Type': 'application/json' }),
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

export const listModels = async (): Promise<ModelInfo[]> => {
  const { baseUrl, apiKey } = await resolveConnection()
  const res = await fetch(`${baseUrl}/api/tags`, { headers: buildHeaders({ baseUrl, apiKey }) })
  if (!res.ok) throw new Error('Failed to list Ollama models')
  const data = (await res.json()) as TagsResponse
  return data.models.map((m) => ({
    id: m.name,
    name: m.name,
    source: 'ollama' as const,
    sizeBytes: m.size
  }))
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
  const { baseUrl, apiKey } = await resolveConnection()
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: buildHeaders({ baseUrl, apiKey }, { 'Content-Type': 'application/json' }),
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
        if (chunk.status === 'success') return
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
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw err
  }
}

export const deleteModel = async (name: string): Promise<void> => {
  const { baseUrl, apiKey } = await resolveConnection()
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: buildHeaders({ baseUrl, apiKey }, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Failed to delete model: ${body || res.statusText}`)
  }

  clearModelContextCache(name)
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

  const { baseUrl, apiKey } = await resolveConnection()
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: buildHeaders({ baseUrl, apiKey }, { 'Content-Type': 'application/json' }),
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
