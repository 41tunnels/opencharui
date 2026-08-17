import { notifyDataChanged } from '../sync'

export type StoreName =
  | 'characters'
  | 'personas'
  | 'chats'
  | 'messages'
  | 'settings'
  | 'tombstones'
  | 'relaySecrets'
  | 'syncMeta'
  | 'syncAcks'
  | 'blobCache'
  | 'pairings'

/** Stores whose writes affect Amallo sync payloads (and warrant cross-tab refresh). */
const SYNC_NOTIFY_STORES: ReadonlySet<StoreName> = new Set([
  'characters',
  'personas',
  'chats',
  'messages',
  'tombstones'
])

const DB_NAME = 'opencharui'
const DB_VERSION = 6

/** Matches db/relay-secrets.ts's `generateId()` shape — kept local rather
 * than shared since it's a 3-line helper and this call site runs inside a
 * versionchange transaction, before that module's own storage helpers can
 * safely be used. */
const generatePairingId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

let dbPromise: Promise<IDBDatabase> | null = null

const resetDbConnection = (): void => {
  dbPromise = null
}

export const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          resetDbConnection()
        }
        resolve(db)
      }
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        if (!db.objectStoreNames.contains('characters')) {
          const store = db.createObjectStore('characters', { keyPath: 'id' })
          store.createIndex('byName', 'name')
          store.createIndex('byUpdatedAt', 'updatedAt')
        }

        if (!db.objectStoreNames.contains('personas')) {
          const store = db.createObjectStore('personas', { keyPath: 'id' })
          store.createIndex('byName', 'name')
          store.createIndex('byUpdatedAt', 'updatedAt')
        }

        if (!db.objectStoreNames.contains('chats')) {
          const store = db.createObjectStore('chats', { keyPath: 'id' })
          store.createIndex('byUpdatedAt', 'updatedAt')
          store.createIndex('byCharacterId', 'characterId')
          store.createIndex('byPersonaId', 'personaId')
        } else {
          const store = request.transaction?.objectStore('chats')
          if (store && !store.indexNames.contains('byPersonaId')) {
            store.createIndex('byPersonaId', 'personaId')
          }
        }

        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' })
          store.createIndex('byChatId', 'chatId')
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' })
        }

        // v3: records deletes so they can propagate to other devices via sync.
        if (!db.objectStoreNames.contains('tombstones')) {
          db.createObjectStore('tombstones', { keyPath: 'id' })
        }

        // v4: relay pairing secrets. A separate store (not `settings`,
        // which JSON.stringifies every value) specifically because a
        // CryptoKey is not JSON-serializable — it round-trips through
        // IndexedDB's structured-clone algorithm instead, which has
        // explicit native support for CryptoKey and preserves its
        // non-extractable flag. See db/relay-secrets.ts.
        if (!db.objectStoreNames.contains('relaySecrets')) {
          db.createObjectStore('relaySecrets', { keyPath: 'key' })
        }

        // v5: the generic sync engine's own state (see browser/sync/).
        // None of these three are in SYNC_NOTIFY_STORES — writing an ack or
        // cursor must never itself schedule another sync pass.
        if (!db.objectStoreNames.contains('syncMeta')) {
          // Small keyed rows: cursor, storeId, clientId, lastSyncedAt.
          // Replaces the old `settings` row keyed 'deviceSync'.
          db.createObjectStore('syncMeta', { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains('syncAcks')) {
          // The server-acknowledged {hash, seq, deleted} per record, keyed
          // `${namespace}:${key}` — what `shouldPush` compares the current
          // local hash against.
          const store = db.createObjectStore('syncAcks', { keyPath: 'id' })
          store.createIndex('byNamespace', 'namespace')
        }
        if (!db.objectStoreNames.contains('blobCache')) {
          // Downloaded blob bytes, keyed by content hash, so re-applying a
          // document doesn't re-download its avatar every pass.
          db.createObjectStore('blobCache', { keyPath: 'hash' })
        }

        // v6: multiple saved relay pairings (see db/pairings.ts) instead of
        // one flat relayUrl/relayPairId/relayPskId triple in `settings`.
        if (!db.objectStoreNames.contains('pairings')) {
          db.createObjectStore('pairings', { keyPath: 'id' })
        }

        // Migrate a pre-existing single pairing, if any, into one row here
        // — reusing its `relaySecrets` PSK row untouched, only ever adding
        // the new indirection on top of it. Runs once, for upgrades that
        // actually crossed v5 (a fresh v6 database has nothing to migrate).
        if (event.oldVersion > 0 && event.oldVersion < 6) {
          const tx = request.transaction
          if (tx) {
            const settingsStore = tx.objectStore('settings')
            const pairingsStore = tx.objectStore('pairings')

            const relayUrlReq = settingsStore.get('relayUrl')
            relayUrlReq.onsuccess = () => {
              const relayUrlRow = relayUrlReq.result as { key: string; value: string } | undefined
              const relayUrl = relayUrlRow ? (JSON.parse(relayUrlRow.value) as string) : ''
              if (!relayUrl) return

              const pairIdReq = settingsStore.get('relayPairId')
              pairIdReq.onsuccess = () => {
                const pairIdRow = pairIdReq.result as { key: string; value: string } | undefined
                const pairId = pairIdRow ? (JSON.parse(pairIdRow.value) as string) : ''
                if (!pairId) return

                const pskIdReq = settingsStore.get('relayPskId')
                pskIdReq.onsuccess = () => {
                  const pskIdRow = pskIdReq.result as { key: string; value: string } | undefined
                  const pskId = pskIdRow ? (JSON.parse(pskIdRow.value) as string) : ''
                  if (!pskId) return

                  const id = generatePairingId()
                  let label = relayUrl
                  try {
                    label = new URL(relayUrl).hostname || relayUrl
                  } catch {
                    // Keep the raw URL as the label if it doesn't parse.
                  }

                  pairingsStore.put({ id, label, relayUrl, pairId, pskId, addedAt: Date.now() })
                  settingsStore.put({ key: 'activePairingId', value: JSON.stringify(id) })
                  settingsStore.delete('relayUrl')
                  settingsStore.delete('relayPairId')
                  settingsStore.delete('relayPskId')
                }
              }
            }
          }
        }
      }
    })
  }
  return dbPromise
}

/** Run a readwrite transaction and resolve only after commit. */
const writeTx = <T> (
  storeName: StoreName,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | void> => {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        let requestResult: T | undefined

        tx.oncomplete = () => resolve(requestResult)
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'))

        const result = fn(tx.objectStore(storeName))
        if (result) {
          result.onsuccess = () => {
            requestResult = result.result as T
          }
          result.onerror = () => reject(result.error ?? new Error('IndexedDB request failed'))
        }
      })
  )
}

/** Run a readonly transaction and resolve with the request result. */
const readTx = <T> (storeName: StoreName, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const request = fn(tx.objectStore(storeName))

        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read transaction failed'))
      })
  )
}

export const get = <T> (storeName: StoreName, key: string): Promise<T | undefined> => {
  return readTx<T | undefined>(storeName, (store) => store.get(key))
}

export const getAll = <T> (storeName: StoreName): Promise<T[]> => {
  return readTx<T[]>(storeName, (store) => store.getAll())
}

export const getAllByIndex = <T> (
  storeName: StoreName,
  indexName: string,
  key: IDBValidKey
): Promise<T[]> => {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const request = tx.objectStore(storeName).index(indexName).getAll(key)

        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => reject(request.error ?? new Error('IndexedDB index read failed'))
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read transaction failed'))
      })
  )
}

export const put = <T> (storeName: StoreName, value: T): Promise<void> => {
  return writeTx(storeName, (store) => store.put(value))
    .then(() => undefined)
    .then(() => {
      if (SYNC_NOTIFY_STORES.has(storeName)) notifyDataChanged()
    })
}

export const putSilent = <T> (storeName: StoreName, value: T): Promise<void> => {
  return writeTx(storeName, (store) => store.put(value)).then(() => undefined)
}

export const deleteByKey = (storeName: StoreName, key: string): Promise<void> => {
  return writeTx(storeName, (store) => store.delete(key))
    .then(() => undefined)
    .then(() => {
      if (SYNC_NOTIFY_STORES.has(storeName)) notifyDataChanged()
    })
}

/** Like deleteByKey but does not notify — used by the sync apply path. */
export const deleteByKeySilent = (storeName: StoreName, key: string): Promise<void> => {
  return writeTx(storeName, (store) => store.delete(key)).then(() => undefined)
}

/** Deletes every row in a store. Used when the sync engine detects the
 * remote store was wiped/replaced (a changed `storeId`) and needs to reset
 * its local bookkeeping (`syncAcks`, cursor) for a full resync — never used
 * on user data stores. */
export const clearStore = (storeName: StoreName): Promise<void> => {
  return writeTx(storeName, (store) => store.clear()).then(() => undefined)
}

export const deleteMessagesForChat = async (
  chatId: string,
  options: { silent?: boolean } = {}
): Promise<void> => {
  const messages = await getAllByIndex<{ id: string }>('messages', 'byChatId', chatId)
  if (messages.length === 0) return

  await openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite')
        const store = tx.objectStore('messages')

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('Failed to delete messages'))
        tx.onabort = () => reject(tx.error ?? new Error('Message delete aborted'))

        for (const message of messages) {
          store.delete(message.id)
        }
      })
  ).then(() => {
    if (!options.silent) notifyDataChanged()
  })
}
