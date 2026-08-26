# Markdown preview default

Markdown files (`.md`, `.markdown`) default to opening in **Markdown Preview** (`MarkdownPreview.tsx`) rather than the CodeMirror code editor.

## Architecture

- The Zustand store (`src/lib/stores/zustand/editor.ts`) tracks `markdownCodeModePaths: Set<string>`, representing files where the user has explicitly switched to code mode.
- `EditorPanel.tsx` computes `showMarkdownPreview = canPreviewMarkdown && !markdownCodeModePaths.has(active)`.
- When a markdown file is first opened, it is not in `markdownCodeModePaths`, so preview is rendered immediately.
- Clicking the toolbar toggle button switches between preview and code editor (`setMarkdownPreview(path, on)`).
- When a file tab is closed or deleted, its entry in `markdownCodeModePaths` is cleaned up so reopening defaults to preview again.
- File renames migrate the code mode state to the new path (`onFileRenamed` in `editor.ts`).
