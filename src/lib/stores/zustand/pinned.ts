import { create } from 'zustand';

export interface PinnedCard {
  id: string;
  type: 'diff' | 'term' | 'prev';
  label: string;
  data?: any;
}

interface PinnedState {
  pinnedCards: PinnedCard[];
  pinCard: (id: string, type: 'diff' | 'term' | 'prev', label: string, data?: any) => void;
  unpinCard: (id: string) => void;
}

export const usePinnedStore = create<PinnedState>((set) => ({
  pinnedCards: [],
  pinCard: (id, type, label, data) =>
    set((state) => {
      if (state.pinnedCards.some((c) => c.id === id)) return state;
      return {
        pinnedCards: [...state.pinnedCards, { id, type, label, data }],
      };
    }),
  unpinCard: (id) =>
    set((state) => ({
      pinnedCards: state.pinnedCards.filter((c) => c.id !== id),
    })),
}));
