import { computed, nextTick, ref } from 'vue'

interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
export type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike

export type JsqrDecode = (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null

// Some platforms (notably Windows/Linux Chromium, and several mobile browsers)
// expose BarcodeDetector but its detection backend never actually finds
// anything — it just silently returns no results forever. Give it a window to
// prove itself, then fall back to the pure-JS decoder that works everywhere.
export const DETECTOR_TIMEOUT_MS = 3000
// Decoding is far slower than a frame, so pacing attempts leaves the phone
// enough main thread to keep the preview smooth.
export const DECODE_INTERVAL_MS = 100
// jsqr is pure JS: a full-resolution phone frame takes long enough to decode
// that the scanner feels stuck, so work from a downscaled copy.
export const MAX_DECODE_EDGE = 640

/** Size to decode at, preserving aspect ratio and never scaling up. */
export const frameSize = (
  videoWidth: number,
  videoHeight: number,
  maxEdge = MAX_DECODE_EDGE
): { width: number; height: number } => {
  const scale = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight))
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale))
  }
}

export interface QrScannerDeps {
  loadFallbackDecoder?: () => Promise<JsqrDecode | null>
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  barcodeDetector?: BarcodeDetectorCtor | null
  now?: () => number
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
}

/**
 * Drives camera QR scanning for the pairing flow.
 *
 * `onCode` receives each decoded value and reports whether it was accepted; a
 * rejected value is remembered so a stale QR held in frame can't pin the
 * scanner in a retry loop against the relay.
 */
export const useQrScanner = (
  onCode: (value: string) => Promise<boolean>,
  deps: QrScannerDeps = {}
) => {
  const {
    // Dynamic import: ~30 KB kept out of the main bundle for the browsers that
    // have a working BarcodeDetector and never need it.
    loadFallbackDecoder = () =>
      import('jsqr').then((m) => m.default as JsqrDecode).catch(() => null),
    now = () => Date.now(),
    requestFrame = (cb: () => void) => requestAnimationFrame(cb),
    cancelFrame = (id: number) => cancelAnimationFrame(id)
  } = deps

  const scanning = ref(false)
  const error = ref<string | null>(null)
  const decoder = ref<'native' | 'fallback' | null>(null)
  const videoEl = ref<HTMLVideoElement | null>(null)
  const canvasEl = ref<HTMLCanvasElement | null>(null)

  let stream: MediaStream | null = null
  let frameId: number | null = null
  let detector: BarcodeDetectorLike | null = null
  let decodeQr: JsqrDecode | null = null
  let fallbackLoad: Promise<JsqrDecode | null> | null = null
  let detectorStartedAt = 0
  let lastDecodeAt = 0
  let lastRejectedCode: string | null = null

  // Naming the live decoder is the only way to tell, from the device itself,
  // which path is running.
  const decoderLabel = computed(() => {
    switch (decoder.value) {
      case 'native':
        return 'Scanning with the browser decoder…'
      case 'fallback':
        return 'Scanning with the in-app decoder…'
      default:
        return null
    }
  })

  const stop = (): void => {
    scanning.value = false
    if (frameId !== null) cancelFrame(frameId)
    frameId = null
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    detector = null
    decodeQr = null
    decoder.value = null
    lastRejectedCode = null
    lastDecodeAt = 0
  }

  const useFallbackDecoder = async (): Promise<void> => {
    // Cached so a mid-scan switch doesn't re-fetch the module on every frame.
    if (!fallbackLoad) fallbackLoad = loadFallbackDecoder()
    const decode = await fallbackLoad
    if (!decode) {
      error.value = 'Could not load the QR decoder. Paste the pairing code instead.'
      stop()
      return
    }
    detector = null
    decodeQr = decode
    decoder.value = 'fallback'
  }

  const grabFrame = (video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null => {
    const { videoWidth, videoHeight } = video
    // A zero-sized frame would make getImageData throw, so wait for real pixels.
    if (!videoWidth || !videoHeight) return null
    const { width, height } = frameSize(videoWidth, videoHeight)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height)
  }

  const handleCode = async (value: string): Promise<boolean> => {
    if (value === lastRejectedCode) return false
    const accepted = await onCode(value)
    if (!accepted) lastRejectedCode = value
    return accepted
  }

  const scanFrame = async (): Promise<boolean> => {
    const video = videoEl.value
    const canvas = canvasEl.value
    // HAVE_CURRENT_DATA is enough to read a frame. Some mobile browsers never
    // advance a live camera stream past it, and waiting for HAVE_ENOUGH_DATA
    // there leaves the preview running with the decoder never looking at it.
    if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return false
    if (now() - lastDecodeAt < DECODE_INTERVAL_MS) return false
    lastDecodeAt = now()

    if (detector) {
      try {
        const codes = await detector.detect(video)
        const value = codes[0]?.rawValue
        if (value) return await handleCode(value)
      } catch {
        // Transient per-frame detection failures are expected — keep scanning.
      }
      if (now() - detectorStartedAt > DETECTOR_TIMEOUT_MS) await useFallbackDecoder()
      return false
    }

    if (decodeQr) {
      const image = grabFrame(video, canvas)
      const result = image && decodeQr(image.data, image.width, image.height)
      if (result?.data) return await handleCode(result.data)
    }
    return false
  }

  const tick = async (): Promise<void> => {
    if (!scanning.value) return
    try {
      if (await scanFrame()) return
    } catch {
      // One bad frame must never end the loop: the camera would stay live with
      // nothing left decoding it, which looks exactly like a frozen scanner.
    }
    if (scanning.value) frameId = requestFrame(() => void tick())
  }

  /** Opens the camera and starts decoding. Resolves once the loop is running. */
  const start = async (): Promise<void> => {
    error.value = null
    const media =
      deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c))
    try {
      stream = await media({ video: { facingMode: 'environment' } })
    } catch {
      error.value = 'Camera access was denied or no camera is available.'
      return
    }

    scanning.value = true
    lastDecodeAt = 0
    lastRejectedCode = null
    // The preview element only renders once scanning is true.
    await nextTick()
    const video = videoEl.value
    if (video) {
      video.srcObject = stream
      await video.play().catch(() => {})
    }

    const Detector =
      deps.barcodeDetector !== undefined
        ? deps.barcodeDetector
        : (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
    if (Detector) {
      try {
        detector = new Detector({ formats: ['qr_code'] })
        detectorStartedAt = now()
        decoder.value = 'native'
      } catch {
        // Constructing it can throw where the format isn't actually supported.
        detector = null
      }
    }
    if (!detector) await useFallbackDecoder()
    // useFallbackDecoder stops the scan if no decoder could be loaded at all.
    if (!scanning.value) return

    frameId = requestFrame(() => void tick())
  }

  return {
    scanning,
    error,
    decoder,
    decoderLabel,
    videoEl,
    canvasEl,
    start,
    stop
  }
}
