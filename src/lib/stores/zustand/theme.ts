import { create } from 'zustand';

interface ThemeState {
  activeTheme: any | null;
  availableThemes: any[];
  __set: (key: string, value: unknown) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  activeTheme: null,
  availableThemes: [],
  __set: (key, value) => set({ [key]: value } as any),
}));
