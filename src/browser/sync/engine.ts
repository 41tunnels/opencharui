// The generic sync engine: probe -> push -> pull -> apply, driven entirely
// by the SyncNamespace registry (namespaces.ts) rather than any per-entity
// branching. Replaces device-sync.ts.
import { resolveConnection, buildHeaders, httpFetch } from '../llm/ollama'
import { broadcastDataChanged, onLocalDataChanged } from '../sync'
import { listTombstones, recordTombstone, removeTombstone } from '../db/tombstones'
import { NAMESPACES } from './namespaces'
import { toBlobRefs, fromBlobRefs, uploadPendingBlobs } from './blobs'
import { sha256Hex, EMPTY_HASH } from './hash'
import * as meta from './meta'
import {
  apiErrorSchema,
  infoResponseSchema,
  pullResponseSchema,
  pushResponseSchema,
  type RecordWire
} from './wire'
import type { SyncStatus } from '@shared/types'

const DOC_TIMEOUT_MS = 15_000
const PULL_LIMIT = 256
const PUSH_BATCH_SIZE = 200
const DEBOUNCE_MS = 2500

// --- status ---------------------------------------------------------------

type StatusListener = (status: SyncStatus, appliedRemote: boolean) => void

let status: SyncStatus = { state: 'disabled', lastSyncedAt: null }
const listeners = new Set<StatusListener>()

const emit = (next: Partial<SyncStatus>, appliedRemote = false): void => {
  status = { ...status, ...next }
  for (const listener of listeners) listener(status, appliedRemote)
}

export const getSyncStatus = (): SyncStatus => status
export const onSyncStatusChanged = (listener: StatusListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// --- transport --------------------------------------------------------------

class SyncHttpError extends Error {
  constructor(
    message: string,
    readonly kind: 'error' | 'unsupported' | 'reapFloor',
    readonly reapFloor?: number
  ) {
    super(message)
  }
}

const request = async (path: string, init: RequestInit, timeoutMs = DOC_TIMEOUT_MS): Promise<unknown> => {
  const connection = await resolveConnection()
  let res: Response
  try {
    res = await httpFetch(connection)(`${connection.baseUrl}${path}`, {
      ...init,
      headers: buildHeaders(connection, {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined)
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    throw new SyncHttpError('amallo unreachable', 'error')
  }

  if (res.status === 401) throw new SyncHttpError('Unauthorized — check API key', 'error')
  if (res.status === 404) throw new SyncHttpError('This amallo version does not support sync', 'unsupported')
  if (res.status === 409) {
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => ({})))
    throw new SyncHttpError(
      'cursor predates this store’s tombstone retention window',
      'reapFloor',
      parsed.success ? parsed.data.reapFloor : undefined
    )
  }
  if (!res.ok) throw new SyncHttpError(`sync failed (${res.status})`, 'error')
  return res.json()
}

const getV1 = (path: string): Promise<unknown> => request(path, { method: 'GET' })
const postV1 = (path: string, body: unknown, timeoutMs?: number): Promise<unknown> =>
  request(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs)

// --- push -------------------------------------------------------------------

interface PushCandidate {
  namespace: string
  key: string
  updatedAt: number
  hash: string
  deleted: boolean
  data?: unknown
}

/** Gathers every local record across every namespace whose content hash
 * doesn't match its last-acknowledged hash — this is what fixes the old
 * engine's missed-write bug (device-sync.ts:227/279): comparison is by
 * content, not by a `lastSyncedAt` clock window, so there is no timing gap
 * a concurrent edit can fall into. */
const gatherPushCandidates = async (pending: Map<string, Uint8Array>): Promise<PushCandidate[]> => {
  const candidates: PushCandidate[] = []
  const sortedByRank = [...NAMESPACES].sort((a, b) => a.rank - b.rank)

  for (const ns of sortedByRank) {
    const localRecords = await ns.list()
    const liveKeys = new Set(localRecords.map((r) => r.key))

    for (const record of localRecords) {
      const substituted = await toBlobRefs(record.data, pending)
      // Hashed and sent from the SAME object reference: JSON.stringify is a
      // pure function of its input, so serializing `substituted` here and
      // again as part of the outer push-request JSON.stringify (below)
      // produces byte-identical text for this field either way — that
      // identity is what lets amallo's server-side hash recomputation
      // agree with this hash without either side canonicalizing anything.
      const hash = await sha256Hex(JSON.stringify(substituted))
      const ack = await meta.getAck(ns.name, record.key)
      if (!ack || ack.hash !== hash) {
        candidates.push({
          namespace: ns.name,
          key: record.key,
          updatedAt: record.updatedAt,
          hash,
          deleted: false,
          data: substituted
        })
      }
    }

    // Local tombstones for this namespace — included only if no live
    // record with that id exists (a resurrected record already removed
    // its own tombstone when it was applied).
    const tombstones = (await listTombstones()).filter(
      (t) => t.collection === ns.name && !liveKeys.has(t.id)
    )
    for (const tomb of tombstones) {
      const ack = await meta.getAck(ns.name, tomb.id)
      if (!ack || ack.hash !== EMPTY_HASH) {
        candidates.push({ namespace: ns.name, key: tomb.id, updatedAt: tomb.deletedAt, hash: EMPTY_HASH, deleted: true })
      }
    }
  }

  return candidates
}

const pushCandidates = async (candidates: PushCandidate[]): Promise<void> => {
  if (candidates.length === 0) return

  for (let i = 0; i < candidates.length; i += PUSH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + PUSH_BATCH_SIZE)
    const body = {
      records: batch.map((c) => ({
        namespace: c.namespace,
        key: c.key,
        hash: c.hash,
        updatedAt: c.updatedAt,
        deleted: c.deleted,
        ...(c.deleted ? {} : { data: c.data })
      }))
    }
    const response = pushResponseSchema.parse(await postV1('/extended/v1/push', body))

    for (const result of response.results) {
      if (result.status === 'applied' || result.status === 'duplicate' || result.status === 'superseded') {
        // The hash alone determines deleted-ness (EMPTY_HASH = tombstone),
        // so there's no need for the server to say so separately — this
        // also correctly reflects a `superseded` result, whose hash is the
        // WINNING device's version, not necessarily this batch's own.
        await meta.setAck({
          id: meta.ackId(result.namespace, result.key),
          namespace: result.namespace,
          key: result.key,
          hash: result.hash,
          seq: result.seq,
          deleted: result.hash === EMPTY_HASH,
          ackedAt: Date.now()
        })
      }
      // 'missingBlobs' should not normally happen (blobs are uploaded
      // before this call) and 'rejected' indicates a real validation bug;
      // both are left un-acked and simply retried on the next pass.
    }
  }
}

// --- pull ---------------------------------------------------------------

interface ApplyCounts {
  data: number
  deleted: number
}

const rankOf = (namespaceByName: Map<string, (typeof NAMESPACES)[number]>, name: string): number =>
  namespaceByName.get(name)?.rank ?? 0

const applyPage = async (
  records: RecordWire[],
  namespaceByName: Map<string, (typeof NAMESPACES)[number]>,
  counts: Map<string, ApplyCounts>
): Promise<boolean> => {
  let appliedAny = false
  const dataRecords = records.filter((r) => !r.deleted).sort((a, b) => rankOf(namespaceByName, a.namespace) - rankOf(namespaceByName, b.namespace))
  const tombstoneRecords = records
    .filter((r) => r.deleted)
    .sort((a, b) => rankOf(namespaceByName, b.namespace) - rankOf(namespaceByName, a.namespace))

  for (const record of dataRecords) {
    const ns = namespaceByName.get(record.namespace)
    if (!ns) continue // a namespace this build doesn't know about - ignore, don't crash
    const hydrated = await fromBlobRefs(record.data)
    const ok = await ns.applyData(record.key, hydrated, record.updatedAt)
    if (!ok) {
      console.warn(`[sync] skipped invalid ${record.namespace} record ${record.key}`)
      continue
    }
    await removeTombstone(record.key)
    const c = counts.get(ns.name) ?? { data: 0, deleted: 0 }
    c.data += 1
    counts.set(ns.name, c)
    appliedAny = true
    await meta.setAck({
      id: meta.ackId(record.namespace, record.key),
      namespace: record.namespace,
      key: record.key,
      hash: record.hash,
      seq: record.seq,
      deleted: false,
      ackedAt: Date.now()
    })
  }

  for (const record of tombstoneRecords) {
    const ns = namespaceByName.get(record.namespace)
    if (!ns) continue
    await ns.applyDelete(record.key)
    await recordTombstone(record.namespace, record.key, record.updatedAt)
    const c = counts.get(ns.name) ?? { data: 0, deleted: 0 }
    c.deleted += 1
    counts.set(ns.name, c)
    appliedAny = true
    await meta.setAck({
      id: meta.ackId(record.namespace, record.key),
      namespace: record.namespace,
      key: record.key,
      hash: record.hash,
      seq: record.seq,
      deleted: true,
      ackedAt: Date.now()
    })
  }

  return appliedAny
}

// --- the pass -------------------------------------------------------------

let syncInFlight = false
let rerunRequested = false
let applyingRemote = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let started = false

const runSync = async (): Promise<SyncStatus> => {
  const connection = await resolveConnection()
  const lastSyncedAt = (await meta.getLastSyncedAt()) ?? null

  // Sync needs *some* form of amallo authentication - either a relay
  // pairing (amallo stamps its own bearer token on that path) or a direct
  // API key (the LAN/tray-copied-connection path). Web never holds a
  // bearer token over the relay, so gating on the raw key alone would
  // silently disable sync for every relay user.
  if (connection.transport !== 'relay' && !connection.apiKey) {
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
  let reconciling = false

  try {
    const info = infoResponseSchema.parse(await getV1('/extended/v1/info'))

    const storedStoreId = await meta.getStoredStoreId()
    if (storedStoreId && storedStoreId !== info.storeId) {
      // The remote store was wiped or replaced - nothing this device
      // thinks it has acknowledged is meaningful evidence of anything.
      await meta.resetForFullResync()
    }
    await meta.setStoredStoreId(info.storeId)

    const clientId = await meta.getClientId()
    const pending = new Map<string, Uint8Array>()
    const candidates = await gatherPushCandidates(pending)
    await uploadPendingBlobs(pending)
    await pushCandidates(candidates)

    const namespaceByName = new Map(NAMESPACES.map((ns) => [ns.name, ns]))
    const counts = new Map<string, ApplyCounts>()
    let cursor = await meta.getCursor()

    for (;;) {
      let page
      try {
        page = pullResponseSchema.parse(
          await postV1('/extended/v1/pull', { since: cursor, limit: PULL_LIMIT, clientId })
        )
      } catch (err) {
        if (err instanceof SyncHttpError && err.kind === 'reapFloor') {
          // This device has been offline long enough that an incremental
          // pull can no longer be trusted - some tombstones from the
          // range it missed may already be gone. Reconcile with a full
          // pull from scratch. Honest trade-off, surfaced below rather
          // than silently absorbed: a record this device deleted locally,
          // or that another device deleted, may reappear.
          await meta.resetForFullResync()
          cursor = 0
          reconciling = true
          continue
        }
        throw err
      }

      const pageApplied = await applyPage(page.records, namespaceByName, counts)
      appliedRemote = appliedRemote || pageApplied

      // Advance the cursor only after the whole page has applied - a crash
      // mid-page re-pulls it next time, and every apply above is
      // idempotent, so replay is safe.
      cursor = page.cursor
      await meta.setCursor(cursor)

      if (!page.more) break
    }

    for (const [name, namespaceCounts] of counts) {
      const ns = namespaceByName.get(name)
      if (ns?.afterApply) await ns.afterApply(namespaceCounts)
    }

    const now = Date.now()
    await meta.setLastSyncedAt(now)
    applyingRemote = false

    if (reconciling) {
      emit(
        {
          state: 'error',
          lastSyncedAt: now,
          error: 'This device was offline too long; some deleted items may reappear'
        },
        appliedRemote
      )
    } else {
      emit({ state: 'idle', lastSyncedAt: now, error: undefined }, appliedRemote)
    }
    if (appliedRemote) broadcastDataChanged() // refresh sibling tabs
  } catch (err) {
    applyingRemote = false
    if (err instanceof SyncHttpError && err.kind === 'unsupported') {
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

// --- public triggers ----------------------------------------------------

const cancelScheduledSync = (): void => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** Run a sync now (manual button / settings change). Resolves with final status. */
export const syncNow = (): Promise<SyncStatus> => {
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
