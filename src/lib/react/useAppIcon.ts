import { useThemeStore } from '$lib/stores/zustand/theme';

/** In-app branding follows the rendered theme, independent of OS appearance. */
export function useAppIcon() {
  const light = useThemeStore((state) => state.activeTheme?.type === 'light');
  return `/icon${light ? '-dark' : ''}.png?v=system-1`;
}
