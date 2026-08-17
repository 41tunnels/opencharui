<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RelayPairingSummary, RelayState } from '@shared/types'

interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike

const pairings = ref<RelayPairingSummary[]>([])
const activeId = ref('')
const state = ref<RelayState | null>(null)
const showAddForm = ref(false)
const nameInput = ref('')
const manualCode = ref('')
const pairError = ref<string | null>(null)
const pairing = ref(false)
const unpairing = ref<string | null>(null)
const switching = ref<string | null>(null)

const renamingId = ref<string | null>(null)
const renameInput = ref('')

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
  const [list, status] = await Promise.all([window.api.relay.list(), window.api.relay.getStatus()])
  pairings.value = list
  activeId.value = status.activeId
  state.value = status.state
}

const applyCode = async (raw: string): Promise<void> => {
  const code = raw.trim()
  if (!code) return
  pairError.value = null
  pairing.value = true
  try {
    await window.api.relay.add(code, nameInput.value.trim() || undefined)
    manualCode.value = ''
    nameInput.value = ''
    stopScan()
    showAddForm.value = false
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

const useServer = async (id: string): Promise<void> => {
  switching.value = id
  try {
    await window.api.relay.setActive(id)
    await refreshStatus()
  } finally {
    switching.value = null
  }
}

const removeServer = async (id: string): Promise<void> => {
  unpairing.value = id
  try {
    await window.api.relay.remove(id)
    await refreshStatus()
  } finally {
    unpairing.value = null
  }
}

const startRename = (row: RelayPairingSummary): void => {
  renamingId.value = row.id
  renameInput.value = row.label
}

const cancelRename = (): void => {
  renamingId.value = null
  renameInput.value = ''
}

const confirmRename = async (id: string): Promise<void> => {
  const label = renameInput.value.trim()
  cancelRename()
  if (!label) return
  await window.api.relay.rename(id, label)
  await refreshStatus()
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

const openAddForm = (): void => {
  pairError.value = null
  showAddForm.value = true
}

const closeAddForm = (): void => {
  showAddForm.value = false
  pairError.value = null
  nameInput.value = ''
  manualCode.value = ''
  stopScan()
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
    <p class="mb-3 text-sm ui-text-muted">
      Pair with one or more amallo instances to chat with your Ollama from anywhere — no network
      setup required. Only the active one is connected at a time.
    </p>

    <ul v-if="pairings.length" class="space-y-2">
      <li
        v-for="row in pairings"
        :key="row.id"
        class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
        :class="row.active ? 'bg-white dark:bg-neutral-900' : ''"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <template v-if="renamingId === row.id">
              <input
                v-model="renameInput"
                class="ui-input px-2 py-1 text-sm"
                autofocus
                @keyup.enter="confirmRename(row.id)"
                @keyup.escape="cancelRename"
              />
            </template>
            <template v-else>
              <p class="truncate text-sm font-medium">
                {{ row.label }}
                <span v-if="row.active" class="ml-1 text-xs font-normal text-green-600 dark:text-green-400">
                  (active)
                </span>
              </p>
              <p class="truncate text-xs ui-text-muted">{{ row.relayUrl }}</p>
              <p v-if="row.active" class="mt-1 text-xs" :class="stateClass">
                {{ stateLabel ?? 'Unknown' }}
              </p>
            </template>
          </div>

          <div class="flex shrink-0 gap-2">
            <template v-if="renamingId === row.id">
              <button class="ui-btn-outline px-2 py-1 text-xs" @click="confirmRename(row.id)">Save</button>
              <button class="ui-btn-outline px-2 py-1 text-xs" @click="cancelRename">Cancel</button>
            </template>
            <template v-else>
              <button
                v-if="!row.active"
                class="ui-btn-outline px-2 py-1 text-xs"
                :disabled="switching === row.id"
                @click="useServer(row.id)"
              >
                {{ switching === row.id ? 'Switching…' : 'Use' }}
              </button>
              <button class="ui-btn-outline px-2 py-1 text-xs" @click="startRename(row)">Rename</button>
              <button
                class="ui-btn-outline px-2 py-1 text-xs"
                :disabled="unpairing === row.id"
                @click="removeServer(row.id)"
              >
                {{ unpairing === row.id ? 'Removing…' : 'Remove' }}
              </button>
            </template>
          </div>
        </div>
      </li>
    </ul>
    <p v-else class="mb-3 text-sm ui-text-muted">No relay servers paired yet.</p>

    <button v-if="!showAddForm" class="ui-btn-outline mt-3 px-3 py-1.5 text-sm" @click="openAddForm">
      Add relay server
    </button>

    <div v-else class="mt-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p class="mb-2 text-sm ui-text-muted">
        Scan or paste the pairing code from amallo's tray menu ("Show Pairing QR…").
      </p>

      <label class="mb-3 block text-sm">
        <span class="mb-1 block font-medium">Name (optional)</span>
        <input
          v-model="nameInput"
          class="ui-input w-full px-3 py-2 text-sm"
          placeholder="e.g. Home PC, Work laptop"
        />
      </label>

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

      <button class="ui-btn-outline mt-3 px-3 py-1.5 text-xs" @click="closeAddForm">Cancel</button>
    </div>
  </div>
</template>
