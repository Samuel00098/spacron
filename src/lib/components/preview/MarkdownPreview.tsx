import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import './MarkdownPreview.css';

export default function MarkdownPreview({
  content = '',
  onLinkClick,
}: {
  content?: string;
  onLinkClick?: (url: string) => void;
}) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content || '', {
        gfm: true,
        breaks: true,
      }) as string;
      return DOMPurify.sanitize(raw);
    } catch (err) {
      console.error('Failed to parse markdown:', err);
      return `<p style="color: var(--error)">Error rendering markdown</p>`;
    }
  }, [content]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href');
    if (href) {
      e.preventDefault();
      e.stopPropagation();
      if (onLinkClick) {
        onLinkClick(href);
      } else {
        void openUrlInPreviewPanel(href);
      }
    }
  };

  return (
    <div className="markdown-container" onClick={handleClick}>
      <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
