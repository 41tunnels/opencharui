import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import {
  DISCONNECT_GRACE_MS,
  useDelayedDisconnect
} from '@renderer/composables/useDelayedDisconnect'

/** Runs the composable inside its own effect scope, like a component would. */
const mount = (initial: boolean) => {
  const source = ref(initial)
  const scope = effectScope()
  const settled = scope.run(() => useDelayedDisconnect(() => source.value))!
  return { source, settled, stop: () => scope.stop() }
}

describe('useDelayedDisconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a disconnect immediately when nothing ever connected', () => {
    const { settled, stop } = mount(true)
    expect(settled.value).toBe(true)
    stop()
  })

  it('holds a drop for the grace period once a connection has been seen', () => {
    const { source, settled, stop } = mount(false)

    source.value = true
    expect(settled.value).toBe(false)

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1)
    expect(settled.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(settled.value).toBe(true)

    stop()
  })

  it('cancels the pending report when the connection comes back in time', () => {
    const { source, settled, stop } = mount(false)

    source.value = true
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 500)
    source.value = false

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2)
    expect(settled.value).toBe(false)

    stop()
  })

  it('restarts the timer on each new drop rather than accumulating time', () => {
    const { source, settled, stop } = mount(false)

    for (let i = 0; i < 3; i++) {
      source.value = true
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 100)
      source.value = false
      vi.advanceTimersByTime(50)
    }
    expect(settled.value).toBe(false)

    source.value = true
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1)
    expect(settled.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(settled.value).toBe(true)

    stop()
  })

  it('clears immediately on reconnect after the overlay is already showing', () => {
    const { source, settled, stop } = mount(false)

    source.value = true
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS)
    expect(settled.value).toBe(true)

    source.value = false
    expect(settled.value).toBe(false)

    stop()
  })

  it('debounces later drops even when the app started disconnected', () => {
    const { source, settled, stop } = mount(true)
    expect(settled.value).toBe(true)

    source.value = false
    source.value = true
    expect(settled.value).toBe(false)
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS)
    expect(settled.value).toBe(true)

    stop()
  })

  it('drops the pending timer when the scope is disposed', () => {
    const { source, settled, stop } = mount(false)

    source.value = true
    stop()
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2)
    expect(settled.value).toBe(false)
  })
})
