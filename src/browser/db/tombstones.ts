import { getAll, putSilent, deleteByKeySilent } from './index'

/** A synced collection whose deletions must propagate across devices. */
export type SyncCollection = 'characters' | 'personas' | 'chats'

/**
 * Record of a locally deleted entity. `id` is the entity's id (so the tombstone
 * and any resurrected record share a key), `deletedAt` doubles as the LWW
 * timestamp. Tombstones are written silently — sync fires a single notify.
 */
export interface Tombstone {
  id: string
  collection: SyncCollection
  deletedAt: number
}

export const recordTombstone = (
  collection: SyncCollection,
  id: string,
  deletedAt: number = Date.now()
): Promise<void> => {
  return putSilent('tombstones', { id, collection, deletedAt })
}

export const listTombstones = (): Promise<Tombstone[]> => {
  return getAll<Tombstone>('tombstones')
}

export const removeTombstone = (id: string): Promise<void> => {
  return deleteByKeySilent('tombstones', id)
}
