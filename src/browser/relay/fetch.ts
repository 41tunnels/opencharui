// relayFetch: a fetch()-signature-compatible function that carries an
// HTTP request/response over a RelayTransport instead of a real socket.
// This is the entire web-side integration seam — ollama.ts's chat(),
// pullModel(), fetchTags(), etc. need no changes beyond choosing this
// transport, because every call site only ever touches res.ok, res.status,
// res.statusText, res.text(), and res.body.getReader() — all of which a
// real Response over a ReadableStream satisfies.
import type { RelayTransport } from './transport'
import { InnerType, type InnerFrame } from './wire'

export interface RelayFetchInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function normalizeHeaders(h?: HeadersInit): [string, string][] {
  if (!h) return []
  const out: [string, string][] = []
  if (h instanceof Headers) {
    h.forEach((value, key) => out.push([key.toLowerCase(), value]))
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out.push([k.toLowerCase(), v])
  } else {
    for (const k of Object.keys(h)) out.push([k.toLowerCase(), (h as Record<string, string>)[k]])
  }
  return out
}

const REQ_BODY_CHUNK = 16 * 1024

async function* bodyChunks(body: BodyInit): AsyncGenerator<Uint8Array> {
  if (typeof body === 'string') {
    const bytes = new TextEncoder().encode(body)
    for (let i = 0; i < bytes.length; i += REQ_BODY_CHUNK) yield bytes.slice(i, i + REQ_BODY_CHUNK)
    return
  }
  if (body instanceof Uint8Array) {
    const bytes: Uint8Array = body
    for (let i = 0; i < bytes.length; i += REQ_BODY_CHUNK) yield bytes.slice(i, i + REQ_BODY_CHUNK)
    return
  }
  if (body instanceof ArrayBuffer) {
    yield* bodyChunks(new Uint8Array(body))
    return
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    yield new Uint8Array(await body.arrayBuffer())
    return
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike)
    }
  }
  throw new Error('relayFetch: unsupported body type')
}

function parseErrorPayload(payload: Uint8Array): { code: string; message?: string } {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as { code: string; message?: string }
  } catch {
    return { code: 'unknown' }
  }
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/** Builds a `relayFetch` bound to a transport getter. A getter (not a
 * transport instance) so callers can swap the underlying transport later
 * (e.g. on re-pairing) without every existing closure over `relayFetch`
 * going stale. */
export function createRelayFetch(getTransport: () => RelayTransport) {
  return async function relayFetch(input: string, init: RelayFetchInit = {}): Promise<Response> {
    // Per the fetch() spec, an already-aborted signal must fail
    // immediately. This isn't just spec fidelity: waitUntilOnline() below
    // can take several microtask ticks (the mock/real handshake), during
    // which a signal aborted synchronously right after this call started
    // would otherwise never be observed — addEventListener('abort', ...)
    // on an already-fired signal does not retroactively invoke the
    // listener, so that race would hang forever without this check.
    if (init.signal?.aborted) {
      throw abortError('The operation was aborted')
    }

    const transport = getTransport()
    try {
      await transport.waitUntilOnline(init.signal ?? undefined)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw abortError('The operation was aborted')
      }
      throw err
    }

    if (init.signal?.aborted) {
      throw abortError('The operation was aborted')
    }

    const streamId = transport.allocateStreamId()
    const { pathname, search } = new URL(input, 'http://relay.invalid')
    const path = pathname + search
    const method = (init.method ?? 'GET').toUpperCase()
    const reqHeaders = normalizeHeaders(init.headers)

    const head = deferred<{ status: number; headers: Headers }>()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let cancelled = false

    const finish = (): void => {
      settled = true
      unsubscribeFrame()
      unsubscribePeerOffline()
      init.signal?.removeEventListener('abort', onAbort)
    }

    const sendCancel = (): void => {
      if (cancelled || settled) return
      cancelled = true
      void transport.send({ type: InnerType.Cancel, streamId, payload: new Uint8Array() }).catch(() => {})
    }

    const unsubscribeFrame = transport.onFrame(streamId, (frame: InnerFrame) => {
      switch (frame.type) {
        case InnerType.Resp: {
          const parsed = JSON.parse(new TextDecoder().decode(frame.payload)) as {
            s: number
            h: [string, string][]
          }
          const respHeaders = new Headers()
          for (const [k, v] of parsed.h) respHeaders.append(k, v)
          head.resolve({ status: parsed.s, headers: respHeaders })
          break
        }
        case InnerType.RespBody:
          bodyController?.enqueue(frame.payload)
          break
        case InnerType.RespEnd:
          bodyController?.close()
          finish()
          break
        case InnerType.Error: {
          const err = parseErrorPayload(frame.payload)
          const e = new Error(`relay: ${err.code}${err.message ? `: ${err.message}` : ''}`)
          head.reject(e)
          bodyController?.error(e)
          finish()
          break
        }
        default:
          break
      }
    })

    const unsubscribePeerOffline = transport.onPeerOffline(() => {
      const err = abortError('relay: agent went offline mid-request')
      head.reject(err)
      bodyController?.error(err)
      finish()
    })

    const onAbort = (): void => {
      sendCancel()
      const err = abortError('The operation was aborted')
      head.reject(err)
      bodyController?.error(err)
      finish()
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })

    // highWaterMark: 8 — once the consumer stops calling read() faster
    // than frames arrive, `enqueue` backs up and the RelayTransport's own
    // sequential frame router (see transport.ts's read loop) stalls
    // behind it, which is what propagates backpressure all the way back
    // through the relay to the agent's own upstream read (see the build
    // plan's Design reference).
    const bodyStream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodyController = controller
        },
        cancel() {
          sendCancel()
        }
      },
      { highWaterMark: 8 }
    )

    void (async () => {
      try {
        await transport.send({
          type: InnerType.Req,
          streamId,
          payload: new TextEncoder().encode(JSON.stringify({ m: method, p: path, h: reqHeaders }))
        })
        if (init.body) {
          for await (const chunk of bodyChunks(init.body)) {
            if (cancelled) return
            await transport.send({ type: InnerType.ReqBody, streamId, payload: chunk })
          }
        }
        if (!cancelled) {
          await transport.send({ type: InnerType.ReqEnd, streamId, payload: new Uint8Array() })
        }
      } catch (err) {
        if (!settled) {
          head.reject(err)
          finish()
        }
      }
    })()

    const { status, headers } = await head.promise
    return new Response(bodyStream, { status, headers })
  }
}
