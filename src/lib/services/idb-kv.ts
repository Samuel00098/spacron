/**
 * A tiny key-value store on IndexedDB, for data that outgrows localStorage.
 *
 * localStorage holds about 5 MB per origin and throws when it is full.
 * IndexedDB is limited by free disk space instead (hundreds of MB to GB in the
 * app's webview), and cannot be given a fixed size: there is no setting to
 * raise or lower it. Values are stored as strings, so callers keep their own
 * serialisation.
 */
const DB_NAME = 'spacron-store';
const STORE = 'kv';

export function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!opened) {
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opened.catch(() => { opened = null; });
  }
  return opened;
}

export async function idbGet(key: string): Promise<string | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(request.error);
  });
}

export async function idbSet(key: string, value: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Ask the webview not to evict this data under disk pressure. Best effort. */
export function requestPersistentStorage(): void {
  try { void navigator.storage?.persist?.(); } catch { /* optional */ }
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
