/**
 * idb.ts — a tiny IndexedDB wrapper for one object store of media blobs.
 *
 * Imported media are `File` objects the browser won't let us reopen from disk
 * after a refresh, so to restore a session we keep the raw bytes here (localStorage
 * is text-only and ~5 MB; IndexedDB holds large Blobs). Keyed by source id; the
 * stored value is the original `File` (structured-clone preserves name + type).
 */

const DB_NAME = 'wazplay'
const DB_VERSION = 1
const STORE = 'media'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Store (or overwrite) a source's file bytes under its id. */
export const idbPutFile = (id: string, file: File): Promise<IDBValidKey> =>
  tx('readwrite', (s) => s.put(file, id))

/** Read a source's file back, or undefined if it isn't stored. */
export const idbGetFile = (id: string): Promise<File | undefined> =>
  tx<File | undefined>('readonly', (s) => s.get(id) as IDBRequest<File | undefined>)

/** Remove one source's bytes. */
export const idbDeleteFile = (id: string): Promise<undefined> =>
  tx<undefined>('readwrite', (s) => s.delete(id) as IDBRequest<undefined>)

/** All stored source ids (to reconcile against the current project). */
export const idbKeys = (): Promise<string[]> =>
  tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) => keys.map(String))

/** Wipe every stored blob (used when the project is cleared). */
export const idbClear = (): Promise<undefined> =>
  tx<undefined>('readwrite', (s) => s.clear() as IDBRequest<undefined>)
