import { useEffect, type RefObject } from 'react';

/**
 * A count of currently-open modal dialogs. Global shortcut handlers (the
 * AppShell / App window keydown listeners) consult this and bail while a modal
 * is open, so a shortcut can never fire an app action behind a dialog. Each
 * mounted modal increments it and decrements on unmount.
 */
export const modalOpenCount = { value: 0 };

/** True while at least one modal dialog is mounted. */
export function isModalOpen(): boolean {
  return modalOpenCount.value > 0;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus management:
 *  - moves focus inside the dialog on mount,
 *  - traps Tab/Shift+Tab within it,
 *  - restores focus to the previously-focused element on unmount,
 *  - registers the modal in `modalOpenCount` so app-wide shortcuts stand down.
 *
 * `onEscape` is optional — the modal can keep its own Escape handling, but the
 * trap and the count apply regardless.
 *
 * `active` defaults to true, for the common case where the component is only
 * mounted while its dialog is open. Pass it explicitly from a host that stays
 * mounted and renders `null` when closed (AgentPlacementModal): hooks can't be
 * called conditionally, so without this the host would increment the count once
 * at startup and never release it — leaving `isModalOpen()` permanently true and
 * every app-wide keyboard shortcut permanently dead.
 */
export function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  active: boolean = true,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    modalOpenCount.value += 1;

    // Move focus into the dialog on open (skip the backdrop). Without this the
    // focus stays on whatever was underneath, so the first Tab lands outside.
    const initialFocus = container?.querySelector<HTMLElement>(FOCUSABLE);
    initialFocus?.focus();

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onEscape?.();
        return;
      }
      if (event.key !== 'Tab' || !container) return;

      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeydown, true);
    return () => {
      document.removeEventListener('keydown', handleKeydown, true);
      modalOpenCount.value = Math.max(0, modalOpenCount.value - 1);
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
