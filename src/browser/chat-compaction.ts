// Rolling compaction: folds a chat's older turns into a "story so far"
// block so the prompt stops growing with the conversation.
//
// The policy lives in `@shared/compaction`; this module is the part that
// touches the model and the database.
import { getCharacter } from './db/characters'
import { getChat, getMessages, saveChatSummary } from './db/chats'
import { getSettings } from './db/settings'
import * as ollama from './llm/ollama'
import { buildMessages } from '@shared/prompt-builder'
import {
  buildSummaryInstruction,
  planCompaction,
  renderFoldedTranscript
} from '@shared/compaction'
import { estimatePromptTokens } from '@shared/context-usage'
import {
  resolveChatContextWindowSize,
  resolveChatGenerationParams,
  resolveChatSystemPrompt
} from '@shared/chat-settings'

/** Room the summary itself is allowed to take. Deliberately small: it is
 * read every turn for the rest of the chat's life. */
const SUMMARY_MAX_TOKENS = 600

/** Low, because this is a recall task. Sampling creatively here invents
 * events that the story is then obliged to honour. */
const SUMMARY_TEMPERATURE = 0.2

export interface CompactionResult {
  folded: number
  keptVerbatim: number
  summaryChars: number
}

/**
 * Compacts `chatId` if its prompt has grown past the threshold, and
 * returns what it did (or null if it did nothing). Failures are reported
 * as null rather than thrown: a summary that could not be written is a
 * missed optimisation, and must not cost the user their message.
 */
export const compactChatIfNeeded = async (
  chatId: string,
  modelId: string
): Promise<CompactionResult | null> => {
  try {
    const chat = await getChat(chatId)
    if (!chat) return null

    const character = await getCharacter(chat.characterId)
    if (!character) return null

    const settings = await getSettings()
    const systemPrompt = resolveChatSystemPrompt(chat, settings.systemPrompt)
    const history = (await getMessages(chatId)).filter((m) => m.role !== 'system')

    // What the prompt costs apart from the uncompacted history: the system
    // block (character card, persona, current summary) plus the turn about
    // to be sent. Built through the real prompt builder so the estimate
    // cannot drift from what is actually sent.
    const scaffold = buildMessages(
      systemPrompt,
      character,
      chat.persona,
      [],
      '',
      resolveChatContextWindowSize(chat),
      { summary: chat.summary, summarizedThrough: chat.summarizedThrough }
    )

    const plan = planCompaction({
      messages: history,
      summarizedThrough: chat.summarizedThrough,
      fixedTokens: estimatePromptTokens(scaffold),
      contextTokens: await ollama.getModelContextLength(modelId)
    })
    if (!plan) return null

    const transcript = renderFoldedTranscript(plan.fold, {
      character: character.name,
      user: chat.persona?.name ?? 'User'
    })

    const summary = await ollama.complete({
      modelId,
      messages: [
        { role: 'system', content: buildSummaryInstruction(chat.summary) },
        { role: 'user', content: transcript }
      ],
      temperature: SUMMARY_TEMPERATURE,
      maxTokens: SUMMARY_MAX_TOKENS,
      // The model is already loaded for the reply that follows; leave that
      // untouched rather than imposing this chat's keep-alive here.
      keepAlive: undefined
    })

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
 * Rebuilds a chat's summary from scratch, ignoring the threshold — backs
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

  const history = (await getMessages(chatId)).filter((m) => m.role !== 'system')
  const plan = planCompaction({
    messages: history,
    summarizedThrough: undefined,
    fixedTokens: 0,
    // Forces a plan whenever there is enough history to be worth folding.
    contextTokens: 1
  })
  if (!plan) return null

  const params = resolveChatGenerationParams(chat, character)
  const summary = await ollama.complete({
    modelId: chat.modelId,
    messages: [
      { role: 'system', content: buildSummaryInstruction() },
      {
        role: 'user',
        content: renderFoldedTranscript(plan.fold, {
          character: character.name,
          user: chat.persona?.name ?? 'User'
        })
      }
    ],
    temperature: SUMMARY_TEMPERATURE,
    maxTokens: SUMMARY_MAX_TOKENS,
    keepAlive: params.keepAliveMinutes === undefined ? undefined : params.keepAliveMinutes
  })

  if (!summary.trim()) throw new Error('The model returned an empty summary')

  await saveChatSummary(chatId, summary, plan.through)
  return { folded: plan.fold.length, keptVerbatim: plan.keeping, summaryChars: summary.length }
}

/** Drops the summary; the chat goes back to sending its history verbatim. */
export const clearChatSummary = async (chatId: string): Promise<void> => {
  await saveChatSummary(chatId, '', undefined)
}
