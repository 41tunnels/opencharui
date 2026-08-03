<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RelayState } from '@shared/types'

interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike

const paired = ref(false)
const relayUrl = ref('')
const state = ref<RelayState | null>(null)
const manualCode = ref('')
const pairError = ref<string | null>(null)
const pairing = ref(false)
const unpairing = ref(false)

const scanning = ref(false)
const scanError = ref<string | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

let stream: MediaStream | null = null
let rafId: number | null = null
let detector: BarcodeDetectorLike | null = null
let decodeQr: ((data: Uint8ClampedArray, width: number, height: number) => { data: string } | null) | null = null
let unsubscribeStatus: (() => void) | null = null

const stateLabel = computed(() => {
  switch (state.value) {
    case 'connecting':
      return 'Connecting…'
    case 'waiting':
      return 'Waiting for amallo…'
    case 'online':
      return 'Connected'
    case 'offline':
      return 'amallo is offline'
    case 'closed':
      return 'Disconnected'
    default:
      return null
  }
})

const stateClass = computed(() => {
  switch (state.value) {
    case 'online':
      return 'text-green-600 dark:text-green-400'
    case 'offline':
    case 'closed':
      return 'text-red-600 dark:text-red-400'
    default:
      return 'text-amber-600 dark:text-amber-400'
  }
})

const refreshStatus = async (): Promise<void> => {
  const status = await window.api.relay.getStatus()
  paired.value = status.paired
  relayUrl.value = status.relayUrl
  state.value = status.state
}

const applyCode = async (raw: string): Promise<void> => {
  const code = raw.trim()
  if (!code) return
  pairError.value = null
  pairing.value = true
  try {
    await window.api.relay.pair(code)
    manualCode.value = ''
    stopScan()
    await refreshStatus()
  } catch (err) {
    pairError.value = err instanceof Error ? err.message : 'Invalid pairing code'
  } finally {
    pairing.value = false
  }
}

const applyManualCode = (): void => {
  void applyCode(manualCode.value)
}

const unpair = async (): Promise<void> => {
  unpairing.value = true
  try {
    await window.api.relay.unpair()
    await refreshStatus()
  } finally {
    unpairing.value = false
  }
}

const scanTick = async (): Promise<void> => {
  if (!scanning.value) return
  const video = videoEl.value
  const canvas = canvasEl.value

  if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
    if (detector) {
      try {
        const codes = await detector.detect(video)
        const value = codes[0]?.rawValue
        if (value) {
          await applyCode(value)
          return
        }
      } catch {
        // Transient per-frame detection failures are expected — keep scanning.
      }
    } else if (decodeQr) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const result = decodeQr(image.data, image.width, image.height)
        if (result?.data) {
          await applyCode(result.data)
          return
        }
      }
    }
  }

  if (scanning.value) rafId = requestAnimationFrame(() => void scanTick())
}

const stopScan = (): void => {
  scanning.value = false
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  detector = null
  decodeQr = null
}

const startScan = async (): Promise<void> => {
  scanError.value = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    scanError.value = 'Camera access was denied or no camera is available.'
    return
  }

  scanning.value = true
  await nextTick()
  if (videoEl.value) {
    videoEl.value.srcObject = stream
    await videoEl.value.play().catch(() => {})
  }

  const BarcodeDetectorGlobal = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector
  if (BarcodeDetectorGlobal) {
    detector = new BarcodeDetectorGlobal({ formats: ['qr_code'] })
  } else {
    // Dynamic import: ~30 KB kept out of the main bundle for the browsers
    // (Chrome/Edge/Android) that have BarcodeDetector and never need it.
    decodeQr = (await import('jsqr')).default
  }

  rafId = requestAnimationFrame(() => void scanTick())
}

onMounted(async () => {
  await refreshStatus()
  unsubscribeStatus = window.api.relay.onStatusChanged((s) => {
    state.value = s
  })
})

onBeforeUnmount(() => {
  unsubscribeStatus?.()
  stopScan()
})
</script>

<template>
  <div class="rounded-xl border border-neutral-200 bg-neutral-100/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/50">
    <h3 class="mb-2 text-sm font-medium">Remote access (amallo relay)</h3>

    <template v-if="paired">
      <p class="text-sm ui-text-muted">
        Paired with <code class="text-neutral-700 dark:text-neutral-300">{{ relayUrl }}</code>
      </p>
      <p class="mt-1 text-sm">
        Status: <span :class="stateClass">{{ stateLabel ?? 'Unknown' }}</span>
      </p>
      <button
        class="ui-btn-outline mt-3 px-3 py-1.5 text-sm"
        :disabled="unpairing"
        @click="unpair"
      >
        {{ unpairing ? 'Unpairing…' : 'Unpair' }}
      </button>
    </template>

    <template v-else>
      <p class="mb-3 text-sm ui-text-muted">
        Scan or paste the pairing code from amallo's tray menu ("Show Pairing QR…") to chat with
        your Ollama from anywhere — no network setup required.
      </p>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <p class="text-sm font-medium">Scan QR code</p>
          <div v-if="!scanning" class="mt-2">
            <button class="ui-btn-outline px-3 py-1.5 text-sm" @click="startScan">
              Open camera
            </button>
          </div>
          <div v-else class="mt-2 space-y-2">
            <video
              ref="videoEl"
              class="aspect-square w-full rounded-lg bg-black object-cover"
              muted
              playsinline
            />
            <canvas ref="canvasEl" class="hidden" />
            <button class="ui-btn-outline px-3 py-1.5 text-xs" @click="stopScan">
              Cancel
            </button>
          </div>
          <p v-if="scanError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ scanError }}</p>
        </div>

        <div class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <p class="text-sm font-medium">Paste pairing code</p>
          <textarea
            v-model="manualCode"
            rows="3"
            class="ui-input mt-2 w-full resize-none px-3 py-2 font-mono text-xs"
            placeholder="opencharui://pair?v=1&..."
          />
          <button
            class="ui-btn-primary mt-2 px-3 py-1.5 text-sm"
            :disabled="pairing || !manualCode.trim()"
            @click="applyManualCode"
          >
            {{ pairing ? 'Connecting…' : 'Connect' }}
          </button>
        </div>
      </div>

      <p v-if="pairError" class="mt-3 text-xs text-red-600 dark:text-red-400">{{ pairError }}</p>
    </template>
  </div>
</template>
