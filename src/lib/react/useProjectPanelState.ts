import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { activeProjectId } from "$lib/stores/workspace";
import { getProjectPanelStateStore } from "$lib/stores/projectPanelState";
import { useStore } from "./useStore";

/** React-state-shaped access to an in-memory value isolated by active project. */
export function useProjectPanelState<T>(
  panelKey: string,
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const projectId = useStore(activeProjectId);
  const store = useMemo(
    () => getProjectPanelStateStore(projectId, panelKey, initialValue),
    // `initialValue` is only a factory for a never-before-seen project/key. A
    // fresh inline function must not replace the store on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, panelKey],
  );
  const value = useStore(store);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      store.update((current) =>
        typeof next === "function" ? (next as (value: T) => T)(current) : next,
      );
    },
    [store],
  );
  return [value, setValue];
}
