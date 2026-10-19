import { historyAfterSummary } from './prompt-builder'
import type { Message } from './types'

/** How many of the most recent assistant replies stay editable. */
export const EDITABLE_ASSISTANT_DEPTH = 3

/** Ids of the assistant messages that may be edited: the latest few, minus
 * any already folded into the chat summary. Only the summary is sent for
 * those turns, so an edit there would never reach the model. */
export const editableAssistantMessageIds = (
  messages: Message[],
  summarizedThrough?: string
): Set<string> => {
  return new Set(
    historyAfterSummary(messages, summarizedThrough)
      .filter((message) => message.role === 'assistant')
      .slice(-EDITABLE_ASSISTANT_DEPTH)
      .map((message) => message.id)
  )
}
