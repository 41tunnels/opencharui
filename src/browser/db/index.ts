import { notifyDataChanged } from '../sync'

export type StoreName = 'characters' | 'personas' | 'chats' | 'messages' | 'settings'

const DB_NAME = 'opencharui'
const DB_VERSION = 2

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
    .then(() => notifyDataChanged())
}

export const putSilent = <T> (storeName: StoreName, value: T): Promise<void> => {
  return writeTx(storeName, (store) => store.put(value)).then(() => undefined)
}

export const deleteByKey = (storeName: StoreName, key: string): Promise<void> => {
  return writeTx(storeName, (store) => store.delete(key))
    .then(() => undefined)
    .then(() => notifyDataChanged())
}

export const deleteMessagesForChat = async (chatId: string): Promise<void> => {
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
  ).then(() => notifyDataChanged())
}
