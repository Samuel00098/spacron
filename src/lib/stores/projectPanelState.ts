import { writable, type Writable } from "./storeCompat";

// Component-local state disappears whenever a room is absent from the next
// project's layout and React unmounts its panel. Keep durable, user-facing
// panel state in a project-keyed store instead. This is intentionally in-memory:
// document/session data that must survive an app restart has its own persisted
// store; this cache preserves the exact panel view while switching projects.
const projectPanelStores = new Map<string, Writable<unknown>>();

function stateKey(projectId: string | null, panelKey: string): string {
  return `${projectId ?? "__no_project__"}\u0000${panelKey}`;
}

export function getProjectPanelStateStore<T>(
  projectId: string | null,
  panelKey: string,
  initialValue: T | (() => T),
): Writable<T> {
  const key = stateKey(projectId, panelKey);
  const existing = projectPanelStores.get(key);
  if (existing) return existing as Writable<T>;

  const value =
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue;
  const store = writable(value);
  projectPanelStores.set(key, store as Writable<unknown>);
  return store;
}

export function clearProjectPanelState(projectId?: string): void {
  if (projectId === undefined) {
    projectPanelStores.clear();
    return;
  }
  const prefix = `${projectId}\u0000`;
  for (const key of projectPanelStores.keys()) {
    if (key.startsWith(prefix)) projectPanelStores.delete(key);
  }
}
