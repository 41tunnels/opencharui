// Streaming behaviour of the Ollama chat client, against a stubbed fetch.
//
// A thinking model streams `message.thinking` for seconds with
// `message.content` empty, and `num_predict` is a budget for both together
// — so reading only `content` produced blank replies, and the reasoning
// could eat the whole budget before a single character of reply was
// written (`done_reason: "length"`, zero content).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, getModelContextLength, invalidateOllamaBaseUrl } from '@browser/llm/ollama'
import { saveSettings } from '@browser/db/settings'

const ndjson = (lines: object[], init?: ResponseInit): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(line) + '\n'))
      }
      controller.close()
    }
  })
  return new Response(body, { status: 200, ...init })
}

const params = {
  modelId: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 512
}

const sentBodies = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] =>
  fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string))

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('opencharui')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  // An explicit direct URL keeps resolveConnection off the relay path, so
  // httpFetch hands back the global fetch this suite stubs.
  await saveSettings({ ollamaUrl: 'http://ollama.test' })
  invalidateOllamaBaseUrl()
})

afterEach(() => {
  vi.unstubAllGlobals()
  invalidateOllamaBaseUrl()
})

describe('ollama chat streaming', () => {
  it('routes thinking and content to separate callbacks', async () => {
    const fetchMock = vi.fn(async () =>
      ndjson([
        { message: { role: 'assistant', content: '', thinking: 'Let me ' } },
        { message: { role: 'assistant', content: '', thinking: 'consider.' } },
        { message: { role: 'assistant', content: 'Hello' } },
        { message: { role: 'assistant', content: ' there' }, done: true }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const tokens: string[] = []
    const thinking: string[] = []
    await chat(params, { onToken: (t) => tokens.push(t), onThinking: (t) => thinking.push(t) })

    expect(tokens.join('')).toBe('Hello there')
    // Reasoning is never part of the reply.
    expect(thinking.join('')).toBe('Let me consider.')
  })

  it('asks for thinking to be off, so reasoning cannot eat the token budget', async () => {
    const fetchMock = vi.fn(async () => ndjson([{ message: { content: 'ok' }, done: true }]))
    vi.stubGlobal('fetch', fetchMock)

    await chat(params, { onToken: () => {} })

    expect(sentBodies(fetchMock)[0]).toMatchObject({ think: false })
  })

  it('retries without the think field when the server rejects it', async () => {
    // Older Ollama builds reject `think` for a model that does not support
    // it. A message must not fail over an optimisation.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"model does not support thinking"}', { status: 400 })
      )
      .mockResolvedValueOnce(ndjson([{ message: { content: 'recovered' }, done: true }]))
    vi.stubGlobal('fetch', fetchMock)

    const tokens: string[] = []
    await chat(params, { onToken: (t) => tokens.push(t) })

    expect(tokens.join('')).toBe('recovered')
    const bodies = sentBodies(fetchMock)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ think: false })
    expect(bodies[1]).not.toHaveProperty('think')
  })

  it('does not retry — or swallow — an unrelated failure', async () => {
    const fetchMock = vi.fn(async () => new Response('model not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(chat(params, { onToken: () => {} })).rejects.toThrow(/model not found/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('model context length', () => {
  it('prefers the window the model is loaded with over the architectural maximum', async () => {
    // /api/show reports what the architecture supports; /api/ps reports
    // what Ollama actually loaded. Sizing prompts against the former is
    // what let a prompt fill the real window and leave ~200 tokens to
    // answer in.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'test-model', context_length: 32768 }] }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ model_info: { 'test.context_length': 262144 } }), {
        status: 200
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await getModelContextLength('test-model')).toBe(32768)
  })

  it('falls back to /api/show while the model is not loaded, without caching it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ model_info: { 'test.context_length': 262144 } }), {
        status: 200
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await getModelContextLength('test-model')).toBe(262144)

    // Once it loads, the real window must win — caching the fallback would
    // pin the architectural number for the rest of the session.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/ps')
          ? new Response(
              JSON.stringify({ models: [{ model: 'test-model', context_length: 8192 }] }),
              { status: 200 }
            )
          : new Response('{}', { status: 200 })
      )
    )
    expect(await getModelContextLength('test-model')).toBe(8192)
  })
})
