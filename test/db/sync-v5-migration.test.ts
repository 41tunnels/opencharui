// Verifies the v4 -> v5 IndexedDB migration (browser/db/index.ts): existing
// user data survives, and the sync engine's three new stores appear.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAll, openDb, put, putSilent } from '@browser/db/index'

const DB_NAME = 'opencharui'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

/** Builds a database at version 4 with the pre-sync-rewrite schema, bypassing
 * the app's own `openDb()` (which always requests the current version) so the
 * v4 -> v5 upgrade path actually runs when the app opens it afterward. */
const createV4Database = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      const characters = db.createObjectStore('characters', { keyPath: 'id' })
      characters.createIndex('byName', 'name')
      characters.createIndex('byUpdatedAt', 'updatedAt')
      const personas = db.createObjectStore('personas', { keyPath: 'id' })
      personas.createIndex('byName', 'name')
      personas.createIndex('byUpdatedAt', 'updatedAt')
      const chats = db.createObjectStore('chats', { keyPath: 'id' })
      chats.createIndex('byUpdatedAt', 'updatedAt')
      chats.createIndex('byCharacterId', 'characterId')
      chats.createIndex('byPersonaId', 'personaId')
      const messages = db.createObjectStore('messages', { keyPath: 'id' })
      messages.createIndex('byChatId', 'chatId')
      db.createObjectStore('settings', { keyPath: 'key' })
      db.createObjectStore('tombstones', { keyPath: 'id' })
      db.createObjectStore('relaySecrets', { keyPath: 'key' })
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

describe('IndexedDB v4 -> v5 migration', () => {
  it('preserves existing data and adds the three sync-engine stores', async () => {
    await createV4Database()

    // Seed v4-shaped data directly (bypassing the app, which would open at
    // the current version) to prove it survives the upgrade untouched.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 4)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('characters', 'readwrite')
        tx.objectStore('characters').put({ id: 'preexisting', name: 'Ada', updatedAt: 100 })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // Now let the app open it — triggers the v4 -> v5 upgrade (and on to
    // v6, since openDb() always requests the current version).
    const db = await openDb()
    expect(db.version).toBe(6)
    expect(db.objectStoreNames.contains('syncMeta')).toBe(true)
    expect(db.objectStoreNames.contains('syncAcks')).toBe(true)
    expect(db.objectStoreNames.contains('blobCache')).toBe(true)

    const characters = await getAll<{ id: string; name: string }>('characters')
    expect(characters).toHaveLength(1)
    expect(characters[0]).toMatchObject({ id: 'preexisting', name: 'Ada' })
  })

  it('the three new stores are writable and readable immediately after migration', async () => {
    await createV4Database()
    await openDb()

    await putSilent('syncMeta', { key: 'cursor', value: 42 })
    await putSilent('syncAcks', { id: 'characters:a', namespace: 'characters', key: 'a', hash: 'h', seq: 1, deleted: false, ackedAt: 1 })
    await put('blobCache', { hash: 'h', mime: 'image/png', bytes: new ArrayBuffer(4) })

    expect((await getAll<{ key: string }>('syncMeta')).map((r) => r.key)).toContain('cursor')
    expect(await getAll('syncAcks')).toHaveLength(1)
    expect(await getAll('blobCache')).toHaveLength(1)
  })
})
