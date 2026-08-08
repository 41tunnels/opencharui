// Registers characters/personas/chats against the generic SyncNamespace
// interface — the only place any of these three entity types is named.
// Adding a fourth synced thing (settings, presets, lorebooks) means adding
// one more entry to NAMESPACES and touching nothing in engine.ts.
import { getAll, getAllByIndex } from '../db/index'
import {
  applySyncedCharacter,
  applyCharacterTombstone,
  type StoredCharacter
} from '../db/characters'
import {
  applySyncedPersona,
  applyPersonaTombstone,
  ensureDefaultPersona,
  type StoredPersona
} from '../db/personas'
import { applySyncedChat, applyChatTombstone } from '../db/chats'
import { characterSchema } from '@shared/character-schema'
import { personaSchema } from '@shared/persona-schema'
import { chatSaveSchema, safeParseChatSave } from '@shared/chat-schema'
import type { Chat, Message } from '@shared/types'
import type { LocalRecord, SyncNamespace } from './registry'

export const characterNamespace: SyncNamespace = {
  name: 'characters',
  rank: 10,
  list: async () => {
    const stored = await getAll<StoredCharacter>('characters')
    return stored.map((s): LocalRecord => {
      const { updatedAt, ...doc } = s
      return { key: s.id, updatedAt, data: { ...characterSchema.parse(doc), id: s.id } }
    })
  },
  applyData: (key, data, updatedAt) => applySyncedCharacter(key, data, updatedAt),
  applyDelete: (key) => applyCharacterTombstone(key)
}

export const personaNamespace: SyncNamespace = {
  name: 'personas',
  rank: 10,
  list: async () => {
    const stored = await getAll<StoredPersona>('personas')
    return stored.map((s): LocalRecord => {
      const { updatedAt, ...doc } = s
      return { key: s.id, updatedAt, data: { ...personaSchema.parse(doc), id: s.id } }
    })
  },
  applyData: (key, data, updatedAt) => applySyncedPersona(key, data, updatedAt),
  applyDelete: (key) => applyPersonaTombstone(key),
  // Was the inline `if (collection === 'personas' && changed)` special case
  // in the old device-sync.ts: if the last persona was tombstoned away,
  // keep the app's "at least one persona" invariant intact.
  afterApply: async ({ data, deleted }) => {
    if (data + deleted > 0) await ensureDefaultPersona()
  }
}

export const chatNamespace: SyncNamespace = {
  name: 'chats',
  rank: 20, // after characters/personas: a chat references both
  list: async () => {
    const chats = await getAll<Chat>('chats')
    const out: LocalRecord[] = []
    for (const chat of chats) {
      const messages = (await getAllByIndex<Message>('messages', 'byChatId', chat.id)).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      // `lastMessageAt` is DERIVED — recomputed both when listing chats and
      // when applying a synced one. Including it here would make two
      // devices holding identical content produce different hashes and
      // re-push forever. `updatedAt` rides on the envelope, not the hash.
      const { updatedAt, lastMessageAt: _derived, ...rest } = chat
      out.push({ key: chat.id, updatedAt, data: chatSaveSchema.parse({ ...rest, messages }) })
    }
    return out
  },
  // Normalizes the signature mismatch: applySyncedChat takes a parsed
  // ChatSaveInput and returns void, unlike the character/persona helpers
  // above, which take (id, data, updatedAt) and return boolean.
  applyData: async (key, data, updatedAt) => {
    const withId = { ...(data as Record<string, unknown>), id: key }
    const parsed = safeParseChatSave(withId)
    if (!parsed.success) {
      console.warn(`[sync] skipped invalid chat ${key}`)
      return false
    }
    await applySyncedChat(parsed.data, updatedAt)
    return true
  },
  applyDelete: (key) => applyChatTombstone(key)
}

/** The one place namespaces are enumerated. Apply/push order within a pass
 * follows `rank`, not array order — see `registry.ts`. */
export const NAMESPACES: readonly SyncNamespace[] = [characterNamespace, personaNamespace, chatNamespace]
