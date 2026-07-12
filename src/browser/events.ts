import type {
  ChatCancelledEvent,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent
} from '@shared/types'

type ChatEventMap = {
  'chat:chunk': ChatChunkEvent
  'chat:done': ChatDoneEvent
  'chat:error': ChatErrorEvent
  'chat:cancelled': ChatCancelledEvent
}

type Handler<T> = (payload: T) => void

const listeners = new Map<keyof ChatEventMap, Set<Handler<unknown>>>()

export const subscribe = <K extends keyof ChatEventMap>(
  channel: K,
  handler: Handler<ChatEventMap[K]>
): (() => void) => {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set())
  }
  listeners.get(channel)!.add(handler as Handler<unknown>)
  return () => listeners.get(channel)?.delete(handler as Handler<unknown>)
}

export const emit = <K extends keyof ChatEventMap>(channel: K, payload: ChatEventMap[K]): void => {
  for (const handler of listeners.get(channel) ?? []) {
    handler(payload)
  }
}
