import { get, getAll, getAllByIndex, putSilent } from './db/index'
import { getSettings } from './db/settings'
import { resolveConnection, buildHeaders } from './llm/ollama'
import { broadcastDataChanged, onLocalDataChanged } from './sync'
import {
  applySyncedCharacter,
  applyCharacterTombstone,
  type StoredCharacter
} from './db/characters'
import {
  applySyncedPersona,
  applyPersonaTombstone,
  ensureDefaultPersona,
  type StoredPersona
} from './db/personas'
import { applySyncedChat, applyChatTombstone } from './db/chats'
import {
  listTombstones,
  recordTombstone,
  removeTombstone,
  type SyncCollection
} from './db/tombstones'
import { safeParseChatSave } from '@shared/chat-schema'
import type { Chat, Message, SyncStatus } from '@shared/types'

const COLLECTIONS: SyncCollection[] = ['characters', 'personas', 'chats']
const DEBOUNCE_MS = 2500
const SETTINGS_KEY = 'deviceSync'

interface Envelope {
  id: string
  updatedAt: number
  deleted?: boolean
  data?: unknown
}

interface SyncResponse {
  records: Envelope[]
  missing: string[]
}

type StatusListener = (status: SyncStatus, appliedRemote: boolean) => void

let status: SyncStatus = { state: 'disabled', lastSyncedAt: null }
const listeners = new Set<StatusListener>()

let syncInFlight = false
let rerunRequested = false
let applyingRemote = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let started = false

const emit = (next: Partial<SyncStatus>, appliedRemote = false): void => {
  status = { ...status, ...next }
  for (const listener of listeners) listener(status, appliedRemote)
}

export const getSyncStatus = (): SyncStatus => status

export const onSyncStatusChanged = (listener: StatusListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// --- lastSyncedAt persistence (device-local; a plain settings row like uiState) --

const loadLastSyncedAt = async (): Promise<number | null> => {
  const row = await get<{ key: string; value: string }>('settings', SETTINGS_KEY)
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as { lastSyncedAt?: number }
    return typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : null
  } catch {
    return null
  }
}

const saveLastSyncedAt = async (value: number): Promise<void> => {
  await putSilent('settings', { key: SETTINGS_KEY, value: JSON.stringify({ lastSyncedAt: value }) })
}

// --- gathering local envelopes ------------------------------------------------

const chatToEnvelopeData = async (chat: Chat): Promise<Record<string, unknown>> => {
  const messages = (await getAllByIndex<Message>('messages', 'byChatId', chat.id)).sort(
    (a, b) => a.createdAt - b.createdAt
  )
  return { ...chat, messages }
}

interface LocalState {
  /** All local envelopes for a collection (live + tombstones), by id. */
  byId: Map<string, Envelope>
  /** id -> updatedAt for every local record (the `known` map). */
  known: Record<string, number>
}

const gatherLocal = async (collection: SyncCollection): Promise<LocalState> => {
  const byId = new Map<string, Envelope>()

  if (collection === 'characters') {
    for (const c of await getAll<StoredCharacter>('characters')) {
      byId.set(c.id, { id: c.id, updatedAt: c.updatedAt, deleted: false, data: c })
    }
  } else if (collection === 'personas') {
    for (const p of await getAll<StoredPersona>('personas')) {
      byId.set(p.id, { id: p.id, updatedAt: p.updatedAt, deleted: false, data: p })
    }
  } else {
    for (const chat of await getAll<Chat>('chats')) {
      byId.set(chat.id, {
        id: chat.id,
        updatedAt: chat.updatedAt,
        deleted: false,
        data: await chatToEnvelopeData(chat)
      })
    }
  }

  // Tombstones override live records only if none exists (a resurrected record
  // would have removed its tombstone); include them so deletes propagate.
  for (const tomb of await listTombstones()) {
    if (tomb.collection !== collection) continue
    if (!byId.has(tomb.id)) {
      byId.set(tomb.id, { id: tomb.id, updatedAt: tomb.deletedAt, deleted: true })
    }
  }

  const known: Record<string, number> = {}
  for (const [id, env] of byId) known[id] = env.updatedAt
  return { byId, known }
}

// --- applying remote envelopes ------------------------------------------------

/** Apply one collection's remote records; returns true if anything changed locally. */
const applyRecords = async (collection: SyncCollection, records: Envelope[]): Promise<boolean> => {
  // Data records first so a chat's character/persona exists before the chat; then
  // tombstones. (Cross-collection ordering is handled by the caller.)
  const data = records.filter((r) => !r.deleted)
  const tombstones = records.filter((r) => r.deleted)
  let changed = false

  for (const env of data) {
    const ok = await applyDataRecord(collection, env)
    if (ok) {
      await removeTombstone(env.id)
      changed = true
    }
  }

  for (const env of tombstones) {
    await applyTombstone(collection, env.id)
    await recordTombstone(collection, env.id, env.updatedAt)
    changed = true
  }

  return changed
}

const applyDataRecord = async (collection: SyncCollection, env: Envelope): Promise<boolean> => {
  if (collection === 'characters') {
    const ok = await applySyncedCharacter(env.id, env.data, env.updatedAt)
    if (!ok) console.warn(`[sync] skipped invalid character ${env.id}`)
    return ok
  }
  if (collection === 'personas') {
    const ok = await applySyncedPersona(env.id, env.data, env.updatedAt)
    if (!ok) console.warn(`[sync] skipped invalid persona ${env.id}`)
    return ok
  }
  const parsed = safeParseChatSave(env.data)
  if (!parsed.success) {
    console.warn(`[sync] skipped invalid chat ${env.id}`)
    return false
  }
  await applySyncedChat(parsed.data, env.updatedAt)
  return true
}

const applyTombstone = async (collection: SyncCollection, id: string): Promise<void> => {
  if (collection === 'characters') return applyCharacterTombstone(id)
  if (collection === 'personas') return applyPersonaTombstone(id)
  return applyChatTombstone(id)
}

// --- the exchange -------------------------------------------------------------

class SyncHttpError extends Error {
  constructor(
    message: string,
    readonly state: 'error' | 'unsupported'
  ) {
    super(message)
  }
}

const postExchange = async (
  collection: SyncCollection,
  body: { records: Envelope[]; known: Record<string, number> }
): Promise<SyncResponse> => {
  const connection = await resolveConnection()
  let res: Response
  try {
    res = await fetch(`${connection.baseUrl}/amallo/sync/${collection}`, {
      method: 'POST',
      headers: buildHeaders(connection, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    })
  } catch {
    throw new SyncHttpError('amallo unreachable', 'error')
  }

  if (res.status === 401) throw new SyncHttpError('Unauthorized — check API key', 'error')
  if (res.status === 404) throw new SyncHttpError('This amallo version does not support sync', 'unsupported')
  if (!res.ok) throw new SyncHttpError(`sync failed (${res.status})`, 'error')

  return (await res.json()) as SyncResponse
}

const syncCollection = async (
  collection: SyncCollection,
  lastSyncedAt: number
): Promise<boolean> => {
  const local = await gatherLocal(collection)

  // Push only what changed since the last successful sync (first sync: all).
  const records = [...local.byId.values()].filter((env) => env.updatedAt > lastSyncedAt)
  const response = await postExchange(collection, { records, known: local.known })

  let changed = await applyRecords(collection, response.records)

  // Server is missing records we hold (fresh/wiped server): push them once.
  if (response.missing.length > 0) {
    const missingEnvelopes = response.missing
      .map((id) => local.byId.get(id))
      .filter((env): env is Envelope => env !== undefined)
    if (missingEnvelopes.length > 0) {
      await postExchange(collection, { records: missingEnvelopes, known: {} })
    }
  }

  // If the last persona was tombstoned away, keep the app's invariant intact.
  if (collection === 'personas' && changed) {
    await ensureDefaultPersona()
  }

  return changed
}

const runSync = async (): Promise<SyncStatus> => {
  const { ollamaApiKey } = await getSettings()
  const lastSyncedAt = await loadLastSyncedAt()

  if (!ollamaApiKey.trim()) {
    emit({ state: 'disabled', lastSyncedAt, error: undefined })
    return status
  }

  if (syncInFlight) {
    rerunRequested = true
    return status
  }

  syncInFlight = true
  applyingRemote = true
  emit({ state: 'syncing', error: undefined })

  let appliedRemote = false
  try {
    for (const collection of COLLECTIONS) {
      const changed = await syncCollection(collection, lastSyncedAt ?? 0)
      appliedRemote = appliedRemote || changed
    }
    const now = Date.now()
    await saveLastSyncedAt(now)
    applyingRemote = false
    emit({ state: 'idle', lastSyncedAt: now, error: undefined }, appliedRemote)
    if (appliedRemote) broadcastDataChanged() // refresh sibling tabs
  } catch (err) {
    applyingRemote = false
    if (err instanceof SyncHttpError && err.state === 'unsupported') {
      emit({ state: 'unsupported', error: err.message })
    } else {
      const message = err instanceof Error ? err.message : 'Sync failed'
      emit({ state: 'error', error: message })
    }
  } finally {
    syncInFlight = false
    if (rerunRequested) {
      rerunRequested = false
      void runSync()
    }
  }

  return status
}

// --- public triggers ----------------------------------------------------------

const cancelScheduledSync = (): void => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** Run a sync now (manual button / settings change). Resolves with final status. */
export const syncNow = (): Promise<SyncStatus> => {
  // Drop any pending debounced run so settings-save does not double-sync.
  cancelScheduledSync()
  rerunRequested = false
  return runSync()
}

const scheduleSync = (): void => {
  if (applyingRemote) return // our own silent writes must not re-trigger us
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSync()
  }, DEBOUNCE_MS)
}

/** Start the engine: one run on boot, then debounced runs after local changes. */
export const startDeviceSync = (): void => {
  if (started) return
  started = true
  onLocalDataChanged(scheduleSync)
  void runSync()
}
