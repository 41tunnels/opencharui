const CHANNEL_NAME = 'opencharui-data'
const TAB_ID = crypto.randomUUID()

let channel: BroadcastChannel | null = null

const localListeners = new Set<() => void>()

const getChannel = (): BroadcastChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME)
  }
  return channel
}

/** Notify other tabs only (not same-tab listeners) that IndexedDB data changed. */
export const broadcastDataChanged = (): void => {
  getChannel()?.postMessage({ type: 'changed', tabId: TAB_ID })
}

/** Notify other tabs — and same-tab listeners — that IndexedDB data changed. */
export const notifyDataChanged = (): void => {
  broadcastDataChanged()
  for (const listener of localListeners) listener()
}

/**
 * Subscribe to data changes originating in THIS tab (BroadcastChannel only
 * reaches other tabs). Used by the sync engine to schedule a debounced push.
 * Returns unsubscribe.
 */
export const onLocalDataChanged = (callback: () => void): (() => void) => {
  localListeners.add(callback)
  return () => localListeners.delete(callback)
}

/** Subscribe to data changes from other tabs. Returns unsubscribe. */
export const onDataChanged = (callback: () => void): (() => void) => {
  const ch = getChannel()
  if (!ch) return () => undefined

  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'changed' && event.data.tabId !== TAB_ID) {
      callback()
    }
  }
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}
