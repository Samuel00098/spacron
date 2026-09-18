import type { AgentCheckpoint } from './agent-transport';

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('spacron-agent-execution', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('turns');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function loadAgentCheckpoint(id: string): Promise<AgentCheckpoint | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('turns').objectStore('turns').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveAgentCheckpoint(id: string, state: AgentCheckpoint, exists: () => boolean): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await open();
  if (!exists()) throw new Error('Conversation was deleted');
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('turns', 'readwrite');
    transaction.objectStore('turns').put(state, id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Checkpoint write aborted'));
  });
}
export async function deleteAgentCheckpoint(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('turns', 'readwrite');
    transaction.objectStore('turns').delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
