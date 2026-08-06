import { create } from 'zustand';

interface BackgroundState {
  /** True when the user has a custom wallpaper stored (independent of the toggle). */
  backgroundImagePresent: boolean;
  __set: (key: string, value: unknown) => void;
}

export const useBackgroundStore = create<BackgroundState>((set) => ({
  backgroundImagePresent: false,
  __set: (key, value) => set({ [key]: value } as any),
}));
