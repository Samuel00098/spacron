import { useState, useMemo, useCallback } from 'react';
import type { SelectedElementInfo } from '$lib/services/element-prompt';
import { buildElementPrompt } from '$lib/services/element-prompt';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { showToast } from '$lib/stores/notification';
import './DesignModePanel.css';

export type DesignModePanelProps = {
  elementInfo: SelectedElementInfo;
  screenshotUrl: string | null;
  onClose: () => void;
  onReselect: () => void;
  onSendToAgent: (prompt: string, screenshotUrl: string | null) => void;
};

type DesignTab = 'prompt' | 'styles' | 'html' | 'attributes';

const PROMPT_PRESETS = [
  {
    label: '🎨 Styling & Colors',
    prompt: 'Update the styling and color palette of this element to match modern UI design standards.',
  },
  {
    label: '📐 Layout & Spacing',
    prompt: 'Adjust the layout, alignment, margins, and padding of this element for better visual balance.',
  },
  {
    label: '📱 Responsive Design',
    prompt: 'Make this element fully responsive so it scales cleanly across mobile, tablet, and desktop screens.',
  },
  {
    label: '✏️ Copy & Typography',
    prompt: 'Improve the typography, font hierarchy, line height, and text readability of this element.',
  },
  {
    label: '⚡ States & Animation',
    prompt: 'Add smooth hover, focus, and active interactive states with CSS transitions to this element.',
  },
  {
    label: '🛠️ Refactor Component',
    prompt: 'Refactor this component for cleaner, more modular markup and improved accessibility (ARIA).',
  },
];

export default function DesignModePanel({
  elementInfo,
  screenshotUrl,
  onClose,
  onReselect,
  onSendToAgent,
}: DesignModePanelProps) {
  const [activeTab, setActiveTab] = useState<DesignTab>('prompt');
  const [userInstructions, setUserInstructions] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState(Boolean(screenshotUrl));
  const [includeStyles, setIncludeStyles] = useState(true);
  const [includeHtml, setIncludeHtml] = useState(true);
  const [styleFilter, setStyleFilter] = useState('');
  const [showImageZoom, setShowImageZoom] = useState(false);

  // Filtered computed styles
  const filteredStyles = useMemo(() => {
    const raw = elementInfo.styles || {};
    const entries = Object.entries(raw).filter(([, val]) => typeof val === 'string' && val.trim() !== '');
    if (!styleFilter.trim()) return entries;
    const q = styleFilter.toLowerCase();
    return entries.filter(([key, val]) => key.toLowerCase().includes(q) || val.toLowerCase().includes(q));
  }, [elementInfo.styles, styleFilter]);

  // Formatted breadcrumb path
  const breadcrumbList = useMemo(() => {
    if (elementInfo.ancestorPath && elementInfo.ancestorPath.length > 0) {
      return elementInfo.ancestorPath;
    }
    const parts = (elementInfo.selector || '').split('>').map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [elementInfo.tag.toLowerCase()];
  }, [elementInfo.ancestorPath, elementInfo.selector, elementInfo.tag]);

  // Attributes list excluding internal noise
  const attributesList = useMemo(() => {
    const attrs = elementInfo.attributes || {};
    return Object.entries(attrs).filter(([k]) => k !== 'data-forge-inspect');
  }, [elementInfo.attributes]);

  const handleSend = useCallback(() => {
    const promptText = buildElementPrompt(elementInfo, {
      userInstructions: userInstructions.trim() || undefined,
      includeStyles,
      includeHtml,
    });
    onSendToAgent(promptText, includeScreenshot ? screenshotUrl : null);
  }, [elementInfo, userInstructions, includeStyles, includeHtml, onSendToAgent, includeScreenshot, screenshotUrl]);

  const handleCopyFullContext = useCallback(async () => {
    const promptText = buildElementPrompt(elementInfo, {
      userInstructions: userInstructions.trim() || undefined,
      includeStyles,
      includeHtml,
    });
    await copyTextToClipboard(promptText);
    showToast('Full element context copied to clipboard', 'success');
  }, [elementInfo, userInstructions, includeStyles, includeHtml]);

  const handleCopySelector = useCallback(async () => {
    await copyTextToClipboard(elementInfo.selector || elementInfo.tag.toLowerCase());
    showToast('Selector copied to clipboard', 'success');
  }, [elementInfo.selector, elementInfo.tag]);

  const handleCopyCss = useCallback(async () => {
    const styles = elementInfo.styles || {};
    const lines = Object.entries(styles)
      .map(([k, v]) => `  ${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`)
      .join('\n');
    const cssBlock = `${elementInfo.selector || elementInfo.tag.toLowerCase()} {\n${lines}\n}`;
    await copyTextToClipboard(cssBlock);
    showToast('CSS styles copied to clipboard', 'success');
  }, [elementInfo.selector, elementInfo.tag, elementInfo.styles]);

  const handleCopyHtml = useCallback(async () => {
    if (elementInfo.html) {
      await copyTextToClipboard(elementInfo.html);
      showToast('HTML snippet copied to clipboard', 'success');
    }
  }, [elementInfo.html]);

  const handlePresetClick = useCallback((text: string) => {
    setUserInstructions((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
  }, []);

  return (
    <aside className="design-mode-panel" aria-label="Orca Design Mode Inspector">
      {/* Header bar */}
      <div className="design-panel-header">
        <div className="design-panel-title-group">
          <div className="design-mode-badge" title="Orca Design Mode">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>Design</span>
          </div>
          <span className="design-element-tag">&lt;{elementInfo.tag.toLowerCase()}&gt;</span>
          <span className="design-element-selector" title={elementInfo.selector}>
            {elementInfo.selector}
          </span>
          <span className="design-element-dims">
            {Math.round(elementInfo.rect.width)} × {Math.round(elementInfo.rect.height)} px
          </span>
        </div>

        <div className="design-panel-actions">
          <button
            type="button"
            className="design-btn-secondary"
            onClick={onReselect}
            title="Pick another element in the preview"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="22" y1="12" x2="18" y2="12" />
              <line x1="6" y1="12" x2="2" y2="12" />
              <line x1="12" y1="6" x2="12" y2="2" />
              <line x1="12" y1="22" x2="12" y2="18" />
            </svg>
            <span>Reselect</span>
          </button>
          <button
            type="button"
            className="design-btn-close"
            onClick={onClose}
            title="Close Design Mode panel"
            aria-label="Close Design Mode panel"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Snapshot and Breadcrumbs overview */}
      <div className="design-panel-overview">
        {screenshotUrl && (
          <div className="design-snapshot-preview" onClick={() => setShowImageZoom(!showImageZoom)} title="Click to expand snapshot">
            <img src={screenshotUrl} alt="Selected element visual snapshot" />
            <span className="design-snapshot-badge">Visual Snapshot</span>
          </div>
        )}

        <div className="design-breadcrumbs-row" title="Element hierarchy in DOM">
          <span className="design-crumb-label">Hierarchy:</span>
          <div className="design-breadcrumbs-scroll">
            {breadcrumbList.map((crumb, idx) => (
              <span key={idx} className="design-crumb-item">
                {crumb}
                {idx < breadcrumbList.length - 1 && <span className="design-crumb-sep">›</span>}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Enlarged image preview modal if clicked */}
      {showImageZoom && screenshotUrl && (
        <div className="design-image-zoom-overlay" onClick={() => setShowImageZoom(false)}>
          <div className="design-image-zoom-card" onClick={(e) => e.stopPropagation()}>
            <img src={screenshotUrl} alt="Expanded visual snapshot" />
            <button type="button" className="design-btn-secondary" onClick={() => setShowImageZoom(false)}>
              Close Zoom
            </button>
          </div>
        </div>
      )}

      {/* Navigation tabs */}
      <div className="design-panel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'prompt'}
          className={`design-tab-btn${activeTab === 'prompt' ? ' active' : ''}`}
          onClick={() => setActiveTab('prompt')}
        >
          <span>💬 Prompt Agent</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'styles'}
          className={`design-tab-btn${activeTab === 'styles' ? ' active' : ''}`}
          onClick={() => setActiveTab('styles')}
        >
          <span>🎨 Computed Styles ({Object.keys(elementInfo.styles || {}).length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'html'}
          className={`design-tab-btn${activeTab === 'html' ? ' active' : ''}`}
          onClick={() => setActiveTab('html')}
        >
          <span>📄 HTML</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'attributes'}
          className={`design-tab-btn${activeTab === 'attributes' ? ' active' : ''}`}
          onClick={() => setActiveTab('attributes')}
        >
          <span>🏷️ Attributes ({attributesList.length})</span>
        </button>
      </div>

      {/* Tab contents */}
      <div className="design-panel-content">
        {/* Tab 1: Prompt Agent */}
        {activeTab === 'prompt' && (
          <div className="design-prompt-tab">
            <div className="design-input-group">
              <label htmlFor="design-prompt-instructions">What should the AI agent change about this element?</label>
              <textarea
                id="design-prompt-instructions"
                rows={3}
                placeholder="e.g. Change background to indigo, make border radius 12px, center text, and add hover highlight..."
                value={userInstructions}
                onChange={(e) => setUserInstructions(e.target.value)}
              />
            </div>

            {/* Quick action preset chips */}
            <div className="design-presets-wrap">
              <span className="design-presets-label">Quick Actions:</span>
              <div className="design-preset-chips">
                {PROMPT_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="design-preset-chip"
                    onClick={() => handlePresetClick(preset.prompt)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Context inclusions */}
            <div className="design-context-toggles">
              {screenshotUrl && (
                <label className="design-checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeScreenshot}
                    onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  />
                  <span>Include Visual Screenshot</span>
                </label>
              )}
              <label className="design-checkbox-label">
                <input
                  type="checkbox"
                  checked={includeStyles}
                  onChange={(e) => setIncludeStyles(e.target.checked)}
                />
                <span>Include Computed CSS</span>
              </label>
              <label className="design-checkbox-label">
                <input
                  type="checkbox"
                  checked={includeHtml}
                  onChange={(e) => setIncludeHtml(e.target.checked)}
                />
                <span>Include HTML Snippet</span>
              </label>
            </div>

            {/* Main Action Bar */}
            <div className="design-action-bar">
              <button
                type="button"
                className="design-btn-primary"
                onClick={handleSend}
                title="Send context and instructions to the active agent terminal"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>Send to Agent</span>
              </button>

              <button
                type="button"
                className="design-btn-secondary"
                onClick={handleCopyFullContext}
                title="Copy complete markdown prompt with all element details"
              >
                <span>📋 Copy Full Context</span>
              </button>

              <button
                type="button"
                className="design-btn-secondary"
                onClick={handleCopySelector}
                title="Copy CSS selector"
              >
                <span>Copy Selector</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: Computed Styles */}
        {activeTab === 'styles' && (
          <div className="design-styles-tab">
            <div className="design-styles-filter-bar">
              <input
                type="search"
                placeholder="Filter CSS properties..."
                value={styleFilter}
                onChange={(e) => setStyleFilter(e.target.value)}
                className="design-styles-search"
              />
              <button type="button" className="design-btn-secondary" onClick={handleCopyCss}>
                Copy CSS Block
              </button>
            </div>

            <div className="design-styles-list">
              {filteredStyles.length === 0 ? (
                <div className="design-empty-state">No matching CSS properties found.</div>
              ) : (
                filteredStyles.map(([prop, val]) => (
                  <div key={prop} className="design-style-row">
                    <span className="design-style-prop">{prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:</span>
                    <span className="design-style-val">{val}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab 3: HTML */}
        {activeTab === 'html' && (
          <div className="design-html-tab">
            <div className="design-tab-actions-row">
              <span className="design-tab-summary">Raw outerHTML snippet</span>
              <button type="button" className="design-btn-secondary" onClick={handleCopyHtml}>
                Copy HTML
              </button>
            </div>
            <pre className="design-code-view">
              <code>{elementInfo.html || 'No HTML available'}</code>
            </pre>
          </div>
        )}

        {/* Tab 4: Attributes */}
        {activeTab === 'attributes' && (
          <div className="design-attributes-tab">
            <div className="design-tab-actions-row">
              <span className="design-tab-summary">Element DOM attributes</span>
              <button type="button" className="design-btn-secondary" onClick={handleCopySelector}>
                Copy Selector
              </button>
            </div>
            <div className="design-attributes-list">
              {attributesList.length === 0 ? (
                <div className="design-empty-state">No attributes on this element.</div>
              ) : (
                attributesList.map(([key, val]) => (
                  <div key={key} className="design-attribute-row">
                    <span className="design-attr-name">{key}=</span>
                    <span className="design-attr-value">"{val}"</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
