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
}

let cachedBaseUrl: string | null = null

export const invalidateOllamaBaseUrl = (): void => {
  cachedBaseUrl = null
  clearModelContextCache()
}

const normalizeOllamaUrl = (url: string): string => url.replace(/\/+$/, '')

const resolveOllamaBaseUrl = async (): Promise<string> => {
  if (cachedBaseUrl) return cachedBaseUrl

  const { ollamaUrl } = await getSettings()
  const custom = ollamaUrl.trim()
  if (custom) {
    cachedBaseUrl = normalizeOllamaUrl(custom)
    return cachedBaseUrl
  }

  cachedBaseUrl = import.meta.env.DEV ? DEV_OLLAMA_PROXY : DEFAULT_OLLAMA_URL
  return cachedBaseUrl
}

export const probeOllama = async (): Promise<boolean> => {
  try {
    const baseUrl = await resolveOllamaBaseUrl()
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
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
    const baseUrl = await resolveOllamaBaseUrl()
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  const baseUrl = await resolveOllamaBaseUrl()
  const res = await fetch(`${baseUrl}/api/tags`)
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
  const baseUrl = await resolveOllamaBaseUrl()
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const baseUrl = await resolveOllamaBaseUrl()
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
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
    options: {
      temperature: params.temperature,
      top_p: params.topP,
      num_predict: params.maxTokens
    }
  }

  console.log('[Ollama] POST /api/chat', body)

  const baseUrl = await resolveOllamaBaseUrl()
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
