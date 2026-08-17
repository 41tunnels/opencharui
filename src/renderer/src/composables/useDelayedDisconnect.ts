import { onScopeDispose, ref, watch, type Ref } from 'vue'

/** How long a drop has to last before it counts as a real disconnect. */
export const DISCONNECT_GRACE_MS = 3000

/**
 * Debounces a "we lost the connection" flag so a brief drop (an Amallo
 * reconnect after a Wi-Fi flip or a tab resume) doesn't immediately take over
 * the screen with the setup overlay.
 *
 * The very first connection is not debounced: with nothing to reconnect to,
 * a disconnected app really does need the setup instructions right away. Once
 * a connection has been seen, every later drop has to persist for `graceMs`
 * before it's reported, and reconnecting inside that window cancels the
 * pending report and resets the timer for the next drop.
 */
export function useDelayedDisconnect(
  disconnected: () => boolean,
  graceMs: number = DISCONNECT_GRACE_MS
): Ref<boolean> {
  const settled = ref(disconnected())
  let everConnected = !settled.value
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  watch(
    disconnected,
    (isDisconnected) => {
      clearTimer()
      if (!isDisconnected) {
        everConnected = true
        settled.value = false
        return
      }
      if (!everConnected) {
        settled.value = true
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        settled.value = true
      }, graceMs)
    },
    // Sync so a flap that resolves within the same tick still cancels the
    // pending timer instead of being coalesced away by the scheduler.
    { flush: 'sync' }
  )

  onScopeDispose(clearTimer)

  return settled
}
