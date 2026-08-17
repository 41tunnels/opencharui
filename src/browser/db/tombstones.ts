import { getAll, putSilent, deleteByKeySilent } from './index'

/**
 * A synced namespace whose deletions must propagate across devices. Any
 * string matching the wire protocol's namespace charset
 * (`/^[a-z][a-z0-9_]{0,31}$/`, see Amallo's `store::validate`) is valid —
 * this is no longer a fixed union. The field is still named `collection`
 * on disk (not `namespace`) deliberately: renaming it would silently
 * orphan any tombstone a user already has stored locally from before this
 * generalization, since IndexedDB does not migrate record shapes.
 */
export type SyncCollection = string

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
