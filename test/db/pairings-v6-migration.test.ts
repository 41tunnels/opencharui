// Verifies the v5 -> v6 IndexedDB migration (browser/db/index.ts): a
// pre-existing single relay pairing (the old flat relayUrl/relayPairId/
// relayPskId settings rows) becomes one row in the new `pairings` store,
// reusing its existing relaySecrets PSK row untouched, and the old rows are
// gone. Also covers the no-pairing case, where migration adds nothing.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAll, openDb, putSilent } from '@browser/db/index'
import { getSettingRow } from '@browser/db/settings'
import type { StoredPairing } from '@shared/types'

const DB_NAME = 'opencharui'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

/** Builds a database at version 5 with the pre-multi-pairing schema,
 * bypassing the app's own `openDb()` (which always requests the current
 * version) so the v5 -> v6 upgrade path actually runs when the app opens
 * it afterward. */
const createV5Database = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 5)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      const characters = db.createObjectStore('characters', { keyPath: 'id' })
      characters.createIndex('byName', 'name')
      characters.createIndex('byUpdatedAt', 'updatedAt')
      db.createObjectStore('personas', { keyPath: 'id' })
      db.createObjectStore('chats', { keyPath: 'id' })
      db.createObjectStore('messages', { keyPath: 'id' })
      db.createObjectStore('settings', { keyPath: 'key' })
      db.createObjectStore('tombstones', { keyPath: 'id' })
      db.createObjectStore('relaySecrets', { keyPath: 'key' })
      db.createObjectStore('syncMeta', { keyPath: 'key' })
      db.createObjectStore('syncAcks', { keyPath: 'id' })
      db.createObjectStore('blobCache', { keyPath: 'hash' })
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

const seedV5Settings = (rows: Array<{ key: string; value: unknown }>): Promise<void> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 5)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('settings', 'readwrite')
      const store = tx.objectStore('settings')
      for (const row of rows) store.put({ key: row.key, value: JSON.stringify(row.value) })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

describe('IndexedDB v5 -> v6 migration', () => {
  it('migrates an existing single pairing into the new pairings store', async () => {
    await createV5Database()
    await seedV5Settings([
      { key: 'relayUrl', value: 'wss://relay.example.com' },
      { key: 'relayPairId', value: 'cGFpcmlkMTIzNDU2' },
      { key: 'relayPskId', value: 'existing-psk-id' }
    ])

    const db = await openDb()
    expect(db.version).toBe(6)
    expect(db.objectStoreNames.contains('pairings')).toBe(true)

    const pairings = await getAll<StoredPairing>('pairings')
    expect(pairings).toHaveLength(1)
    expect(pairings[0]).toMatchObject({
      label: 'relay.example.com',
      relayUrl: 'wss://relay.example.com',
      pairId: 'cGFpcmlkMTIzNDU2',
      pskId: 'existing-psk-id'
    })

    const activeRow = await getSettingRow('activePairingId')
    expect(activeRow && JSON.parse(activeRow.value)).toBe(pairings[0]!.id)

    // The old flat fields are gone.
    expect(await getSettingRow('relayUrl')).toBeUndefined()
    expect(await getSettingRow('relayPairId')).toBeUndefined()
    expect(await getSettingRow('relayPskId')).toBeUndefined()
  })

  it('adds no pairing row when no pairing existed', async () => {
    await createV5Database()
    const db = await openDb()
    expect(db.version).toBe(6)

    const pairings = await getAll<StoredPairing>('pairings')
    expect(pairings).toHaveLength(0)

    const activeRow = await getSettingRow('activePairingId')
    expect(activeRow).toBeUndefined()
  })

  it('preserves unrelated existing data across the upgrade', async () => {
    await createV5Database()
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 5)
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

    await openDb()
    const characters = await getAll<{ id: string; name: string }>('characters')
    expect(characters).toHaveLength(1)
    expect(characters[0]).toMatchObject({ id: 'preexisting', name: 'Ada' })
  })

  it('the pairings store is writable and readable immediately after migration', async () => {
    await createV5Database()
    await openDb()

    await putSilent('pairings', {
      id: 'p1',
      label: 'Home PC',
      relayUrl: 'wss://relay.example.com',
      pairId: 'aa',
      pskId: 'bb',
      addedAt: Date.now()
    })

    expect(await getAll('pairings')).toHaveLength(1)
  })
})
