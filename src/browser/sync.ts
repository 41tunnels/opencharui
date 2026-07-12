const CHANNEL_NAME = 'opencharui-data'
const TAB_ID = crypto.randomUUID()

let channel: BroadcastChannel | null = null

const getChannel = (): BroadcastChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME)
  }
  return channel
}

/** Notify other tabs that IndexedDB data changed. */
export const notifyDataChanged = (): void => {
  getChannel()?.postMessage({ type: 'changed', tabId: TAB_ID })
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
