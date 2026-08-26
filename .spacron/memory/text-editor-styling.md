# Hybrid editor styling

The editor ([`CodeEditor.tsx`](file:///src/lib/components/editor/CodeEditor.tsx)) uses a refined hybrid design: the precision and utility of a code editor combined with the breathing room and elegance of a modern text editor.

## Characteristics
- **Subtle, borderless gutter**: Line numbers are muted and low-contrast without heavy vertical borders, maintaining visual calmness.
- **Hover-revealed fold markers**: Code fold arrows stay invisible until hovering over the gutter.
- **Soft active line indicator**: Gentle, subtle active line background and active line number accent.
- **Refined typography**: Crisp monospace coding font with comfortable line-height (1.62) and relaxed padding.
- **Clean tab design**: Rounded pill tabs with language-colored document icons and clean hover close buttons in [`EditorTabs.tsx`](file:///src/lib/components/editor/EditorTabs.tsx).
