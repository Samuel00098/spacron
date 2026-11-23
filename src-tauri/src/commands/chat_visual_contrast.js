// Generated pages can mix theme tokens with literal colors. Repair only text
// that loses contrast over a solid background, leaving artwork and charts alone.
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;

  const marker = 'data-spacron-readable-ink';
  const measuring = 'data-spacron-measuring-ink';
  const repaired = new Set();
  const colors = new Map();
  const paint = document.createElement('style');
  paint.textContent = `
    html [data-spacron-readable-ink="black"] { color: #000 !important; }
    html [data-spacron-readable-ink="white"] { color: #fff !important; }
    html [data-spacron-measuring-ink] { transition: none !important; }
  `;
  document.head.append(paint);

  function rgba(css) {
    if (!colors.has(css)) {
      // Canvas normalizes computed rgb(), color(srgb …), oklab(), and other
      // CSS color formats to the same sRGB channels.
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'transparent';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      colors.set(css, Array.from(context.getImageData(0, 0, 1, 1).data));
    }
    return colors.get(css);
  }

  function composite(front, back) {
    const alpha = front[3] / 255;
    return front.slice(0, 3).map((value, index) => value * alpha + back[index] * (1 - alpha));
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((value) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function repair() {
    if (!document.body) return;
    const previous = [...repaired];
    for (const element of previous) {
      element.setAttribute(measuring, '');
      element.removeAttribute(marker);
    }
    repaired.clear();
    colors.clear();

    const root = document.documentElement;
    const base = getComputedStyle(root).colorScheme === 'dark' ? [16, 16, 16] : [239, 239, 239];
    const backgrounds = new Map();
    function background(element) {
      if (!element) return base;
      if (backgrounds.has(element)) return backgrounds.get(element);
      const style = getComputedStyle(element);
      const fill = rgba(style.backgroundColor);
      let result = null;
      if (style.backgroundImage === 'none') {
        if (fill[3] === 255) result = fill.slice(0, 3);
        else {
          const behind = background(element.parentElement);
          if (behind) result = composite(fill, behind);
        }
      }
      backgrounds.set(element, result);
      return result;
    }

    const labels = new Set(document.body.querySelectorAll('input, textarea, select'));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (text.nodeValue.trim() && text.parentElement) labels.add(text.parentElement);
    }
    const fixes = [];
    for (const element of labels) {
      if (element.closest('svg, canvas, script, style, option, [aria-hidden="true"], :disabled')) continue;
      if (element.matches('input') && !element.matches('[type="text"], [type="search"], [type="number"], [type="email"], [type="password"], [type="url"], input:not([type])')) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || !element.getClientRects().length) continue;
      const surface = background(element);
      if (!surface) continue;
      const text = rgba(style.color);
      if (text[3] === 0) continue;
      const ink = luminance(composite(text, surface));
      const paper = luminance(surface);
      const ratio = (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
      if (ratio < 4.5) fixes.push([element, paper > 0.179 ? 'black' : 'white']);
    }
    for (const [element, ink] of fixes) {
      element.setAttribute(marker, ink);
      repaired.add(element);
    }
    for (const element of previous) element.removeAttribute(measuring);
  }

  let pending;
  function schedule() {
    if (pending !== undefined) return;
    pending = requestAnimationFrame(() => {
      pending = undefined;
      repair();
    });
  }

  window.addEventListener('spacron:theme', schedule);
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'color' || event.propertyName === 'background-color') schedule();
  });
  const paintDeclarations = (style) => (style ?? '').match(
    /(?:^|;)\s*(?:color|background(?:-color|-image)?|display|visibility|--[\w-]+)\s*:[^;]*/gi,
  )?.join(';') ?? '';
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver((changes) => {
      // Ignore ticking text and progress bar widths, which do not change ink.
      if (changes.some((change) => {
        if (change.type === 'attributes') {
          return change.attributeName !== 'style'
            || paintDeclarations(change.oldValue) !== paintDeclarations(change.target.getAttribute('style'));
        }
        return [...change.addedNodes, ...change.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE);
      })) schedule();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-selected', 'aria-pressed'],
    });
    schedule();
  });
})();
