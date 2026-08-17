// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { DETECTOR_TIMEOUT_MS, frameSize, useQrScanner } from '@renderer/composables/useQrScanner'
import type { JsqrDecode } from '@renderer/composables/useQrScanner'

/**
 * A hand-driven frame scheduler: the loop only advances when the test says so,
 * so each assertion sits at a known point instead of racing rAF.
 */
const scheduler = () => {
  let queued: (() => void) | null = null
  let clock = 0
  return {
    requestFrame: (cb: () => void) => {
      queued = cb
      return 1
    },
    cancelFrame: () => {
      queued = null
    },
    now: () => clock,
    advanceClock: (ms: number) => {
      clock += ms
    },
    pending: () => queued !== null,
    /** Runs one frame and lets its awaits settle. */
    frame: async () => {
      const run = queued
      queued = null
      run?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream

/** A video element that reports the given readiness and frame size. */
const stubVideo = (readyState: number, width = 1280, height = 720) => {
  const video = document.createElement('video')
  Object.defineProperty(video, 'readyState', { value: readyState })
  Object.defineProperty(video, 'videoWidth', { value: width })
  Object.defineProperty(video, 'videoHeight', { value: height })
  // happy-dom type-checks srcObject and won't take a stand-in stream.
  Object.defineProperty(video, 'srcObject', { writable: true, value: null })
  video.play = vi.fn().mockResolvedValue(undefined)
  return video
}

/** Canvas whose 2d context yields a fixed, decodable buffer. */
const stubCanvas = (onGetImageData?: () => void) => {
  const canvas = document.createElement('canvas')
  canvas.getContext = vi.fn().mockReturnValue({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      onGetImageData?.()
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
    }
  }) as unknown as HTMLCanvasElement['getContext']
  return canvas
}

interface Harness {
  readyState?: number
  decode?: JsqrDecode
  detector?:
    (new (o: { formats: string[] }) => { detect: () => Promise<{ rawValue: string }[]> }) | null
  onCode?: (v: string) => Promise<boolean>
  onGetImageData?: () => void
  width?: number
  height?: number
}

const start = async (opts: Harness = {}) => {
  const clock = scheduler()
  const codes: string[] = []
  const onCode =
    opts.onCode ??
    (async (v: string) => {
      codes.push(v)
      return true
    })
  const wrappedOnCode = async (v: string) => {
    if (opts.onCode) codes.push(v)
    return onCode(v)
  }

  const scanner = useQrScanner(wrappedOnCode, {
    getUserMedia: async () => fakeStream(),
    barcodeDetector: (opts.detector ?? null) as never,
    loadFallbackDecoder: async () => opts.decode ?? (() => null),
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame
  })

  // Bind the elements the way the template's refs would.
  scanner.videoEl.value = stubVideo(opts.readyState ?? 2, opts.width, opts.height)
  scanner.canvasEl.value = stubCanvas(opts.onGetImageData)
  const startPromise = scanner.start()
  await nextTick()
  await startPromise

  return { scanner, clock, codes }
}

describe('useQrScanner', () => {
  it('decodes a stream that never advances past HAVE_CURRENT_DATA', async () => {
    // The regression: gating on HAVE_ENOUGH_DATA left mobile browsers that
    // plateau at readyState 2 previewing the camera but never decoding.
    const { clock, codes } = await start({
      readyState: 2,
      decode: () => ({ data: 'opencharui://pair?v=1' })
    })

    clock.advanceClock(200)
    await clock.frame()

    expect(codes).toEqual(['opencharui://pair?v=1'])
  })

  it('keeps looping when a frame throws', async () => {
    // getImageData throws on a zero-sized frame; if that escaped the tick, the
    // loop was never rescheduled and the camera sat there decoding nothing.
    let calls = 0
    const { clock, codes } = await start({
      readyState: 2,
      onGetImageData: () => {
        calls += 1
        if (calls === 1) throw new Error('IndexSizeError')
      },
      decode: () => ({ data: 'code-after-failure' })
    })

    clock.advanceClock(200)
    await clock.frame()
    expect(codes).toEqual([])
    expect(clock.pending()).toBe(true)

    clock.advanceClock(200)
    await clock.frame()
    expect(codes).toEqual(['code-after-failure'])
  })

  it('falls back when the native detector stays quiet', async () => {
    class SilentDetector {
      async detect(): Promise<{ rawValue: string }[]> {
        return []
      }
    }
    const { scanner, clock, codes } = await start({
      readyState: 2,
      detector: SilentDetector as never,
      decode: () => ({ data: 'from-fallback' })
    })

    expect(scanner.decoder.value).toBe('native')

    clock.advanceClock(DETECTOR_TIMEOUT_MS + 1)
    await clock.frame()
    expect(scanner.decoder.value).toBe('fallback')

    clock.advanceClock(200)
    await clock.frame()
    expect(codes).toEqual(['from-fallback'])
  })

  it('stops retrying a code the relay rejected, but keeps scanning', async () => {
    const { scanner, clock, codes } = await start({
      readyState: 2,
      decode: () => ({ data: 'stale-code' }),
      onCode: async () => false
    })

    clock.advanceClock(200)
    await clock.frame()
    clock.advanceClock(200)
    await clock.frame()

    expect(codes).toEqual(['stale-code'])
    expect(scanner.scanning.value).toBe(true)
    expect(clock.pending()).toBe(true)
  })

  it('surfaces an error and stops when no decoder can be loaded', async () => {
    const clock = scheduler()
    const scanner = useQrScanner(async () => true, {
      getUserMedia: async () => fakeStream(),
      barcodeDetector: null,
      loadFallbackDecoder: async () => null,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    })
    scanner.videoEl.value = stubVideo(2)
    scanner.canvasEl.value = stubCanvas()

    const startPromise = scanner.start()
    await nextTick()
    await startPromise

    expect(scanner.error.value).toMatch(/Paste the pairing code/)
    expect(scanner.scanning.value).toBe(false)
    expect(clock.pending()).toBe(false)
  })
})

describe('frameSize', () => {
  it('scales a phone frame down to the decode budget', () => {
    expect(frameSize(1920, 1080, 640)).toEqual({ width: 640, height: 360 })
  })

  it('never scales a small frame up', () => {
    expect(frameSize(320, 240, 640)).toEqual({ width: 320, height: 240 })
  })
})
