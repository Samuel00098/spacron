import { useEffect } from 'react';

export function useGlobalTooltips() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    // Create the tooltip element
    let tooltipEl = document.getElementById('spacron-global-tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = 'spacron-global-tooltip';
      tooltipEl.className = 'global-tooltip';
      document.body.appendChild(tooltipEl);
    }

    let activeElement: HTMLElement | null = null;
    let showTimeout: ReturnType<typeof setTimeout> | null = null;

    const positionTooltip = (trigger: HTMLElement, tooltip: HTMLElement) => {
      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();

      // Default: position centered above the trigger
      let left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
      let top = triggerRect.top - tooltipRect.height - 8;

      // Constrain to window bounds
      if (left < 8) left = 8;
      if (left + tooltipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tooltipRect.width - 8;
      }

      // If it overflows the top of the window, position it below the trigger instead
      if (top < 8) {
        top = triggerRect.bottom + 8;
      }

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const handleMouseOver = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[title], [data-tooltip]') as HTMLElement | null;
      if (!target || target === activeElement) return;

      // Clear previous timeout
      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }

      activeElement = target;

      // Extract content. A live `title` always wins over the cached copy:
      // `data-tooltip` is only a stash of the title we stripped to suppress the
      // native tooltip, and React re-applies `title` whenever the prop changes.
      // Reading the cache first froze a button's text at whatever it said on the
      // very first hover — dock buttons whose label depends on state (Focus /
      // Split / Fleet swap to "Back to split" when active) never updated, and a
      // renamed room kept its old name until a full reload.
      const liveTitle = target.getAttribute('title');
      let content: string;
      if (liveTitle) {
        content = liveTitle;
        target.setAttribute('data-tooltip', liveTitle);
        target.removeAttribute('title'); // Prevent native tooltip
      } else {
        content = target.getAttribute('data-tooltip') || '';
      }

      if (!content || !tooltipEl) return;

      // Wait for a deliberate hover so passing across controls stays quiet.
      showTimeout = setTimeout(() => {
        if (!tooltipEl || !target) return;
        tooltipEl.textContent = content;
        tooltipEl.classList.add('visible');
        positionTooltip(target, tooltipEl);
      }, 700);
    };

    const handleMouseOut = (e: MouseEvent) => {
      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }

      if (!activeElement || !tooltipEl) return;

      const relatedTarget = e.relatedTarget as HTMLElement | null;
      if (relatedTarget && activeElement.contains(relatedTarget)) {
        return;
      }

      activeElement = null;
      tooltipEl.classList.remove('visible');
    };

    const handleMouseDown = () => {
      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
      }
    };

    const handleMouseLeaveWindow = () => {
      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
      }
      activeElement = null;
    };

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mouseleave', handleMouseLeaveWindow, true);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('mouseout', handleMouseOut, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mouseleave', handleMouseLeaveWindow, true);
      if (tooltipEl && tooltipEl.parentNode) {
        tooltipEl.parentNode.removeChild(tooltipEl);
      }
    };
  }, []);
}
