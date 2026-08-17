/** One live record as this device holds it, ready to be hashed and pushed.
 * Blob substitution (large data URLs -> `$blob` refs) happens centrally in
 * `engine.ts`, not per namespace — `data` here still has real data URLs
 * inline. */
export interface LocalRecord {
  key: string
  /** Envelope timestamp. NOT part of the hash — see `hash.ts`. */
  updatedAt: number
  /** The document. Built through the entity's schema so a field added in a
   * newer app version doesn't silently reorder keys, and with derived /
   * volatile fields (e.g. `lastMessageAt`) already stripped. */
  data: unknown
}

/**
 * Everything the sync engine needs to know about one namespace. Contract:
 *
 * - `applyData`/`applyDelete` MUST be idempotent. The engine advances its
 *   pull cursor only after a whole page applies, so a crash mid-page
 *   replays the page. At-least-once delivery is the guarantee; exactly-once
 *   is not.
 * - `applyData` MUST NOT verify cross-namespace references (e.g. a chat
 *   checking its character exists). A referenced record may arrive in a
 *   later page. This property is load-bearing — do not "fix" it by adding
 *   a check; `db/chats.ts`'s `applySyncedChat` already relies on it.
 * - Every write inside `applyData`/`applyDelete` MUST go through the
 *   `*Silent` db helpers (`db/index.ts`'s `putSilent`/`deleteByKeySilent`),
 *   or applying remote data re-triggers a push of what was just applied.
 * - `list()` MUST build documents through the entity's zod schema, and
 *   MUST exclude `updatedAt` and any derived/volatile field from `data`.
 *   The hash is computed over `JSON.stringify(data)` verbatim — two
 *   devices holding identical content must produce byte-identical text, or
 *   they will never converge to `duplicate` and will re-push forever.
 */
export interface SyncNamespace {
  /** Wire namespace. Must match `/^[a-z][a-z0-9_]{0,31}$/` (Amallo's
   * `store::validate::valid_namespace`). */
  readonly name: string

  /**
   * Apply order within one pulled page. Lower ranks apply first, so a
   * namespace others reference (characters, personas) ranks below one that
   * references it (chats). Deletions apply in DESCENDING rank — a cascade
   * removes children before parents. Replaces the ordering the old
   * `COLLECTIONS` array order carried implicitly.
   */
  readonly rank: number

  /** Every live local record in this namespace, normalized per the
   * contract above. Tombstones are gathered separately by the engine from
   * `db/tombstones.ts` — namespaces never see their own deletes here. */
  list(): Promise<LocalRecord[]>

  /** Apply one remote record. Return `false` to skip it (validation
   * failure) — the engine logs and moves on without retrying. */
  applyData(key: string, data: unknown, updatedAt: number): Promise<boolean>

  /** Apply a remote deletion. Must tolerate the record already being gone
   * locally (idempotent, per the contract above). */
  applyDelete(key: string): Promise<void>

  /** Runs once per sync pass (not per page), after every record of this
   * namespace across every pulled page has applied. `counts` are the
   * totals for this pass. */
  afterApply?(counts: { data: number; deleted: number }): Promise<void>
}
