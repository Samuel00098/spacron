/** A file the orchestrator changed directly: its content before the turn, and what it wrote. */
export interface TurnEditRecord {
  path: string;
  original: string | null;
  written: string;
}

/**
 * The files the orchestrator's last turn changed directly, per conversation,
 * kept so "undo" lasts as long as the offer to use it.
 *
 * The transcript is persisted and it carries the offer ("Say \"undo\" to
 * restore it"). A module-level Map is not: an app restart — or a dev-server
 * module reload — left that sentence on screen with nothing behind it, and the
 * request then fell through to the model, which has no undo tool and answered
 * in prose while the edit stayed on disk. The record has to outlive the module
 * or the offer is a promise the runtime cannot keep.
 *
 * IndexedDB rather than the thread store, because these records hold whole
 * file contents and the thread store is localStorage, whose few megabytes are
 * already spent on the transcript itself. Its own database rather than the
 * agent-checkpoint one, because two modules opening the same database at
 * different versions block each other.
 *
 * No expiry: age is not what makes a restore unsafe. `undoLastTurnEdits`
 * refuses any file whose content no longer matches what the turn wrote, so a
 * record is either still exactly reversible or already declined.
 */
const memory = new Map<string, TurnEditRecord[]>();

const DB_NAME = 'spacron-turn-undo';
const STORE = 'edits';

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

/**
 * True where IndexedDB can be reached at all — false under the node test
 * environment and during SSR, where the in-memory map is the whole store.
 */
function durable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Persist this turn's edits, replacing whatever the conversation held before. */
export async function saveTurnEdits(conversationKey: string, records: TurnEditRecord[]): Promise<void> {
  memory.set(conversationKey, records);
  if (!durable()) return;
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(records, conversationKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Undo record write aborted'));
    });
  } catch (error) {
    // A turn must not fail because its undo record could not be saved. The
    // in-memory copy still serves this session; only durability is lost.
    console.warn('Could not persist the undo record for this turn:', error);
  }
}

/** This conversation's last turn of direct edits, or an empty list. */
export async function loadTurnEdits(conversationKey: string): Promise<TurnEditRecord[]> {
  const cached = memory.get(conversationKey);
  if (cached) return cached;
  if (!durable()) return [];
  try {
    const db = await open();
    const stored = await new Promise<TurnEditRecord[] | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(conversationKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    console.warn('Could not read the undo record for this conversation:', error);
    return [];
  }
}

/** Drop the record: an undo that has been applied is not offered twice. */
export async function clearTurnEdits(conversationKey: string): Promise<void> {
  memory.delete(conversationKey);
  if (!durable()) return;
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(conversationKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn('Could not clear the undo record for this conversation:', error);
  }
}

/** Test hook: forget every in-memory record between cases. */
export function resetTurnEditsForTests(): void {
  memory.clear();
}
