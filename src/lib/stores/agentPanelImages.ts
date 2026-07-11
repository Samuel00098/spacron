import { writable } from '$lib/stores/storeCompat';

export interface AgentPanelImage {
  id: string;
  objectUrl: string;
  diskPath: string;
  name: string;
}

function createAgentPanelImagesStore() {
  const { subscribe, update } = writable<Map<number, AgentPanelImage[]>>(new Map());

  return {
    subscribe,
    add(sessionId: number, image: AgentPanelImage) {
      update((map) => {
        const next = new Map(map);
        const existing = next.get(sessionId) ?? [];
        next.set(sessionId, [...existing, image]);
        return next;
      });
    },
    remove(sessionId: number, imageId: string) {
      update((map) => {
        const next = new Map(map);
        const existing = next.get(sessionId) ?? [];
        const removed = existing.find((img) => img.id === imageId);
        if (removed) URL.revokeObjectURL(removed.objectUrl);
        next.set(sessionId, existing.filter((img) => img.id !== imageId));
        return next;
      });
    },
    clear(sessionId: number) {
      update((map) => {
        const next = new Map(map);
        const images = next.get(sessionId);
        if (images) images.forEach((img) => URL.revokeObjectURL(img.objectUrl));
        next.delete(sessionId);
        return next;
      });
    },
  };
}

export const agentPanelImages = createAgentPanelImagesStore();
