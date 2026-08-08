// The sync engine's own local state: pull cursor, store identity, this
// device's id, and per-record server-acknowledged hashes. None of these
// three IndexedDB stores are in SYNC_NOTIFY_STORES (db/index.ts) — writing
// an ack or advancing the cursor must never itself schedule another push.
import { get, getAll, getAllByIndex, putSilent, clearStore } from '../db/index'

interface MetaRow {
  key: string
  value: unknown
}

const getMeta = async <T>(key: string): Promise<T | undefined> => {
  const row = await get<MetaRow>('syncMeta', key)
  return row?.value as T | undefined
}

const setMeta = (key: string, value: unknown): Promise<void> => putSilent('syncMeta', { key, value })

/** Pull cursor: `since` for the next incremental pull. 0 = full resync. */
export const getCursor = async (): Promise<number> => (await getMeta<number>('cursor')) ?? 0
export const setCursor = (value: number): Promise<void> => setMeta('cursor', value)

/** The remote store's identity, as of the last successful pass. A change
 * means the server was wiped or replaced — see `engine.ts`'s probe step. */
export const getStoredStoreId = (): Promise<string | undefined> => getMeta<string>('storeId')
export const setStoredStoreId = (value: string): Promise<void> => setMeta('storeId', value)

export const getLastSyncedAt = (): Promise<number | undefined> => getMeta<number>('lastSyncedAt')
export const setLastSyncedAt = (value: number): Promise<void> => setMeta('lastSyncedAt', value)

/** A UUID this device mints once and reuses forever — not a credential,
 * just the input to tombstone reaping's per-client cursor floor on the
 * server. Old `deviceSync` settings row is superseded by this store; it is
 * not migrated (see `engine.ts`'s first-run comment). */
export const getClientId = async (): Promise<string> => {
  const existing = await getMeta<string>('clientId')
  if (existing) return existing
  const id = crypto.randomUUID()
  await setMeta('clientId', id)
  return id
}

export interface SyncAck {
  id: string
  namespace: string
  key: string
  hash: string
  seq: number
  deleted: boolean
  ackedAt: number
}

export const ackId = (namespace: string, key: string): string => `${namespace}:${key}`

export const getAck = (namespace: string, key: string): Promise<SyncAck | undefined> =>
  get<SyncAck>('syncAcks', ackId(namespace, key))

export const setAck = (ack: SyncAck): Promise<void> => putSilent('syncAcks', ack)

export const getAcksForNamespace = (namespace: string): Promise<SyncAck[]> =>
  getAllByIndex<SyncAck>('syncAcks', 'byNamespace', namespace)

export const getAllAcks = (): Promise<SyncAck[]> => getAll<SyncAck>('syncAcks')

/** Resets all engine bookkeeping for a full resync: the server's store was
 * wiped/replaced (`storeId` changed) or a pull cursor fell below the
 * tombstone reap floor. Acks are cleared too — an ack recorded against a
 * store that no longer exists (or a state the server has since aged past)
 * is not meaningful evidence of anything. */
export const resetForFullResync = async (): Promise<void> => {
  await clearStore('syncAcks')
  await setCursor(0)
}
