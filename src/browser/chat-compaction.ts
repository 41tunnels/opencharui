// Rolling compaction: folds a chat's older turns into a "story so far"
// block so the prompt stops growing with the conversation.
//
// The policy lives in `@shared/compaction`; this module is the part that
// touches the model and the database.
//
// Compaction runs *while the user types* (see `chat.compactIfDue` in
// api.ts), not in front of the reply — a summarisation pass is a full
// non-streaming model call, and paying for it during dead time is the
// whole point. `awaitCompaction` is what the generation path uses to join
// a pass that is still running instead of building a prompt from a summary
// that is about to change.
import { getCharacter } from './db/characters'
import { getChat, getMessages, saveChatSummary } from './db/chats'
import { getSettings } from './db/settings'
import { emit } from './events'
import * as ollama from './llm/ollama'
import { buildSummaryInstruction, planCompaction, renderFoldedTranscript } from '@shared/compaction'
import { resolveChatGenerationParams, toOllamaKeepAlive } from '@shared/chat-settings'
import type { AppSettings } from '@shared/types'

export interface CompactionResult {
  folded: number
  keptVerbatim: number
  summaryChars: number
}

/** One pass per chat at a time. A second caller joins the running promise
 * rather than starting a duplicate model call — the typing trigger fires
 * repeatedly, and the send path awaits whatever it finds here. */
const inFlight = new Map<string, Promise<CompactionResult | null>>()

const summaryParams = (settings: AppSettings) => ({
  temperature: settings.compactionTemperature,
  topP: settings.compactionTopP,
  maxTokens: settings.compactionMaxTokens
})

/**
 * Compacts `chatId` if enough messages have accrued since the last pass,
 * and returns what it did (or null if it did nothing). Failures are
 * reported as null rather than thrown: a summary that could not be written
 * is a missed optimisation, and must not cost the user their message.
 */
export const compactChatIfDue = (chatId: string): Promise<CompactionResult | null> => {
  const running = inFlight.get(chatId)
  if (running) return running

  const pass = runCompaction(chatId).finally(() => inFlight.delete(chatId))
  inFlight.set(chatId, pass)
  return pass
}

/** Resolves once no compaction is in flight for `chatId`. Never starts
 * one — the typing trigger owns that decision. */
export const awaitCompaction = async (chatId: string): Promise<void> => {
  await inFlight.get(chatId)
}

const runCompaction = async (chatId: string): Promise<CompactionResult | null> => {
  try {
    const chat = await getChat(chatId)
    if (!chat) return null

    const character = await getCharacter(chat.characterId)
    if (!character) return null

    const settings = await getSettings()
    const history = (await getMessages(chatId)).filter((m) => m.role !== 'system')

    const plan = planCompaction({
      messages: history,
      summarizedThrough: chat.summarizedThrough,
      interval: settings.compactionInterval,
      keepRecent: settings.compactionKeepRecent
    })
    if (!plan) return null

    const modelId = chat.modelId ?? (await ollama.getDefaultModelId())
    if (!modelId) return null

    const transcript = renderFoldedTranscript(plan.fold, {
      character: character.name,
      user: chat.persona?.name ?? 'User'
    })

    // Announced only once there is really a pass to run: the typing trigger
    // calls in on every keystroke pause, and most of those do nothing.
    emit('chat:compacting', { chatId, active: true })
    let summary: string
    try {
      summary = await ollama.complete({
        modelId,
        messages: [
          {
            role: 'system',
            content: buildSummaryInstruction(settings.compactionPrompt, chat.summary)
          },
          { role: 'user', content: transcript }
        ],
        ...summaryParams(settings),
        // Compaction now runs before the reply is even requested, so honour
        // the chat's keep-alive here: it leaves the model warm for the turn
        // the user is in the middle of typing.
        keepAlive: toOllamaKeepAlive(resolveChatGenerationParams(chat, character).keepAliveMinutes)
      })
    } finally {
      emit('chat:compacting', { chatId, active: false })
    }

    if (!summary.trim()) return null

    await saveChatSummary(chatId, summary, plan.through)
    console.log(
      `[chat] compacted ${plan.fold.length} messages into a ${summary.length}-char summary, ${plan.keeping} kept verbatim`
    )
    return {
      folded: plan.fold.length,
      keptVerbatim: plan.keeping,
      summaryChars: summary.length
    }
  } catch (err) {
    console.warn('[chat] compaction skipped:', err)
    return null
  }
}

/**
 * Rebuilds a chat's summary from scratch, ignoring the interval — backs
 * the "rebuild" action in chat settings, and the recovery path when a
 * summary has drifted. Throws, unlike the automatic path: here the user
 * asked for it and is waiting for the result.
 */
export const rebuildChatSummary = async (chatId: string): Promise<CompactionResult | null> => {
  const chat = await getChat(chatId)
  if (!chat) throw new Error('Chat not found')
  if (!chat.modelId) throw new Error('This chat has no model selected')

  const character = await getCharacter(chat.characterId)
  if (!character) throw new Error('Character not found')

  const settings = await getSettings()
  const history = (await getMessages(chatId)).filter((m) => m.role !== 'system')
  const plan = planCompaction({
    messages: history,
    summarizedThrough: undefined,
    // Forces a plan whenever there is anything at all to fold.
    interval: 1,
    keepRecent: settings.compactionKeepRecent
  })
  if (!plan) return null

  const params = resolveChatGenerationParams(chat, character)
  const summary = await ollama.complete({
    modelId: chat.modelId,
    messages: [
      { role: 'system', content: buildSummaryInstruction(settings.compactionPrompt) },
      {
        role: 'user',
        content: renderFoldedTranscript(plan.fold, {
          character: character.name,
          user: chat.persona?.name ?? 'User'
        })
      }
    ],
    ...summaryParams(settings),
    keepAlive: toOllamaKeepAlive(params.keepAliveMinutes)
  })

  if (!summary.trim()) throw new Error('The model returned an empty summary')

  await saveChatSummary(chatId, summary, plan.through)
  return { folded: plan.fold.length, keptVerbatim: plan.keeping, summaryChars: summary.length }
}

/** Drops the summary; the chat goes back to sending its history verbatim. */
export const clearChatSummary = async (chatId: string): Promise<void> => {
  await saveChatSummary(chatId, '', undefined)
}
