import { create } from 'zustand';

/** Title bar elements that AppShell portals its voice, layout and minimized-panel controls into. */
interface TitleBarSlots {
  layout: HTMLElement | null;
  menu: HTMLElement | null;
  voice: HTMLElement | null;
  parked: HTMLElement | null;
  setParked: (el: HTMLElement | null) => void;
  setLayout: (el: HTMLElement | null) => void;
  setMenu: (el: HTMLElement | null) => void;
  setVoice: (el: HTMLElement | null) => void;
}

export const useTitleBarSlots = create<TitleBarSlots>((set) => ({
  layout: null,
  menu: null,
  voice: null,
  parked: null,
  setParked: (parked) => set({ parked }),
  setLayout: (layout) => set({ layout }),
  setMenu: (menu) => set({ menu }),
  setVoice: (voice) => set({ voice }),
}));
