import BrowserActionIcon from './BrowserActionIcon';
import Dropdown from '$lib/components/shared/Dropdown';
import { useAgentTargets } from '$lib/react/useAgentTargets';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  getActiveAgentTargets,
  resolveDefaultTarget,
  dispatchPromptToAgent,
  type AgentTarget,
} from '$lib/services/agent-target';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { showToast } from '$lib/stores/notification';
import './PreviewAnnotationOverlay.css';

export type AnnotationTool = 'pen' | 'arrow' | 'rectangle' | 'text';

export type AnnotationPoint = { x: number; y: number };

export type AnnotationItem =
  | { type: 'path'; points: AnnotationPoint[]; color: string; width: number }
  | { type: 'arrow'; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: 'rect'; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: 'text'; point: AnnotationPoint; text: string; color: string; fontSize: number };

export type PreviewAnnotationOverlayProps = {
  viewportWidth: number;
  viewportHeight: number;
  captureUnderlyingScreenshot: () => Promise<{ dataUrl: string; x: number; y: number; width: number; height: number } | null>;
  onClose: () => void;
};

const COLOR_PALETTE = [
  { id: 'red', color: '#ef4444', label: 'Red (Defect/Attention)' },
  { id: 'accent', color: '#6366f1', label: 'Spacron Indigo (Accent)' },
  { id: 'yellow', color: '#f59e0b', label: 'Amber (Warning/Notice)' },
  { id: 'green', color: '#10b981', label: 'Emerald (Success/Keep)' },
  { id: 'white', color: '#f8fafc', label: 'White (Contrast)' },
];

const STROKE_WIDTHS = [
  { id: 'fine', width: 2, label: 'Fine (2px)' },
  { id: 'medium', width: 4, label: 'Medium (4px)' },
  { id: 'bold', width: 8, label: 'Bold (8px)' },
];

const QUICK_PROMPTS = [
  'Fix the visual defect and alignment highlighted in this drawing.',
  'Move and restyle the element as indicated by the arrow.',
  'Implement the UI changes and notes drawn on this screen.',
  'Adjust spacing and color palette to match the annotated area.',
];

export default function PreviewAnnotationOverlay({
  viewportWidth,
  viewportHeight,
  captureUnderlyingScreenshot,
  onClose,
}: PreviewAnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeTool, setActiveTool] = useState<AnnotationTool>('pen');
  const [activeColor, setActiveColor] = useState<string>('#ef4444');
  const [activeStrokeWidth, setActiveStrokeWidth] = useState<number>(4);

  const [items, setItems] = useState<AnnotationItem[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const currentPathRef = useRef<AnnotationPoint[]>([]);
  const startPointRef = useRef<AnnotationPoint | null>(null);

  // Inline text editing
  const [textInputPos, setTextInputPos] = useState<AnnotationPoint | null>(null);
  const [textInputValue, setTextInputValue] = useState('');
  const textInputRef = useRef<HTMLInputElement | null>(null);

  // Send modal state
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false);
  const [compositeSnapshot, setCompositeSnapshot] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [userPrompt, setUserPrompt] = useState('');
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (!isPromptModalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setIsPromptModalOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isPromptModalOpen]);

  // Agent target selection
  const availableTargets = useAgentTargets();
  const defaultTarget = useMemo(() => resolveDefaultTarget(availableTargets), [availableTargets]);
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(defaultTarget?.id ?? null);

  const currentTarget = useMemo(() => {
    return selectedTargetId === null ? defaultTarget : availableTargets.find((t) => t.id === selectedTargetId) ?? null;
  }, [availableTargets, selectedTargetId, defaultTarget]);

  // Redraw canvas whenever items change
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const item of items) {
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (item.type === 'path') {
        if (item.points.length < 2) continue;
        ctx.lineWidth = item.width;
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i++) {
          ctx.lineTo(item.points[i].x, item.points[i].y);
        }
        ctx.stroke();
      } else if (item.type === 'arrow') {
        ctx.lineWidth = item.width;
        drawArrow(ctx, item.start.x, item.start.y, item.end.x, item.end.y, item.width);
      } else if (item.type === 'rect') {
        ctx.lineWidth = item.width;
        const x = Math.min(item.start.x, item.end.x);
        const y = Math.min(item.start.y, item.end.y);
        const w = Math.abs(item.end.x - item.start.x);
        const h = Math.abs(item.end.y - item.start.y);

        // Subtle fill for clear visibility
        ctx.fillStyle = `${item.color}22`;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      } else if (item.type === 'text') {
        ctx.font = `bold ${item.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const metrics = ctx.measureText(item.text);
        const textH = item.fontSize + 4;
        const padX = 8;
        const padY = 4;

        // Dark callout badge background for high legibility
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.5;
        const badgeX = item.point.x - padX;
        const badgeY = item.point.y - textH + padY;
        const badgeW = metrics.width + padX * 2;
        const badgeH = textH + padY * 2;

        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(item.text, item.point.x, item.point.y + 2);
      }
    }
  }, [items]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Adjust canvas pixel density
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewportWidth * dpr;
    canvas.height = viewportHeight * dpr;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
    redrawCanvas();
  }, [viewportWidth, viewportHeight, redrawCanvas]);

  // Pointer event handlers
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = viewportWidth / rect.width;
    const scaleY = viewportHeight / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (textInputPos) {
      commitText();
      return;
    }

    const pt = getCanvasCoords(e);
    if (activeTool === 'text') {
      setTextInputPos(pt);
      setTextInputValue('');
      setTimeout(() => textInputRef.current?.focus(), 50);
      return;
    }

    setIsDrawing(true);
    startPointRef.current = pt;
    if (activeTool === 'pen') {
      currentPathRef.current = [pt];
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPointRef.current) return;
    const pt = getCanvasCoords(e);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (activeTool === 'pen') {
      currentPathRef.current.push(pt);
      redrawCanvas();
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = activeStrokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const pts = currentPathRef.current;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    } else if (activeTool === 'arrow') {
      redrawCanvas();
      ctx.strokeStyle = activeColor;
      ctx.fillStyle = activeColor;
      drawArrow(ctx, startPointRef.current.x, startPointRef.current.y, pt.x, pt.y, activeStrokeWidth);
    } else if (activeTool === 'rectangle') {
      redrawCanvas();
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = activeStrokeWidth;
      const x = Math.min(startPointRef.current.x, pt.x);
      const y = Math.min(startPointRef.current.y, pt.y);
      const w = Math.abs(pt.x - startPointRef.current.x);
      const h = Math.abs(pt.y - startPointRef.current.y);
      ctx.fillStyle = `${activeColor}22`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPointRef.current) return;
    const pt = getCanvasCoords(e);
    const start = { ...startPointRef.current };
    setIsDrawing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (activeTool === 'pen') {
      const pts = currentPathRef.current;
      if (pts.length > 1) {
        setItems((prev) => [
          ...prev,
          { type: 'path', points: pts, color: activeColor, width: activeStrokeWidth },
        ]);
      }
      currentPathRef.current = [];
    } else if (activeTool === 'arrow') {
      if (Math.hypot(pt.x - startPointRef.current.x, pt.y - startPointRef.current.y) > 5) {
        setItems((prev) => [
          ...prev,
          {
            type: 'arrow',
            start,
            end: pt,
            color: activeColor,
            width: activeStrokeWidth,
          },
        ]);
      }
    } else if (activeTool === 'rectangle') {
      if (Math.abs(pt.x - startPointRef.current.x) > 4 && Math.abs(pt.y - startPointRef.current.y) > 4) {
        setItems((prev) => [
          ...prev,
          {
            type: 'rect',
            start,
            end: pt,
            color: activeColor,
            width: activeStrokeWidth,
          },
        ]);
      }
    }
    startPointRef.current = null;
  };

  const commitText = () => {
    if (textInputPos && textInputValue.trim()) {
      setItems((prev) => [
        ...prev,
        {
          type: 'text',
          point: textInputPos,
          text: textInputValue.trim(),
          color: activeColor,
          fontSize: 14,
        },
      ]);
    }
    setTextInputPos(null);
    setTextInputValue('');
  };

  const handleUndo = () => {
    setItems((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setItems([]);
  };

  // Build composite image: webpage snapshot + annotations
  const generateCompositeSnapshot = async (): Promise<string | null> => {
    setIsCapturing(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const capture = await captureUnderlyingScreenshot();
      if (!capture) return null;
      const canvas = canvasRef.current;
      if (!canvas) return null;

      const offscreen = document.createElement('canvas');
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      offscreen.width = image.naturalWidth;
      offscreen.height = image.naturalHeight;
      const oCtx = offscreen.getContext('2d');
      if (!oCtx) return null;

      oCtx.drawImage(image, 0, 0);
      oCtx.drawImage(canvas, capture.x * canvas.width, capture.y * canvas.height,
        capture.width * canvas.width, capture.height * canvas.height, 0, 0, offscreen.width, offscreen.height);
      return offscreen.toDataURL('image/png');
    } catch {
      return null;
    } finally {
      setIsCapturing(false);
    }
  };

  const handleOpenSendModal = async () => {
    if (items.length === 0) {
      showToast('Draw or write on the page first before sending', 'info');
      return;
    }
    const snap = await generateCompositeSnapshot();
    if (!snap) {
      showToast('Could not capture the page screenshot.', 'error');
      return;
    }
    setCompositeSnapshot(snap);
    setIsPromptModalOpen(true);
  };

  const handleCopyImage = async () => {
    if (!compositeSnapshot) return;
    try {
      await copyTextToClipboard(compositeSnapshot);
      showToast('Image base64 copied to clipboard', 'success');
    } catch {
      showToast('Could not copy image', 'error');
    }
  };

  const handleSendToAgent = async () => {
    if (!currentTarget) {
      showToast('No active agent found. Please start an agent in Terminal.', 'warning');
      return;
    }

    setIsSending(true);
    try {
      const prompt = userPrompt.trim()
        ? `[Site Visual Annotation]\n${userPrompt.trim()}`
        : '[Site Visual Annotation]\nPlease inspect the attached drawing with annotations and apply the requested changes.';

      const ok = await dispatchPromptToAgent(currentTarget, prompt, {
        imageDataUrl: compositeSnapshot,
        imageName: `annotated-page-${Date.now()}.png`,
      });

      if (ok) {
        showToast(`Drawing and instructions sent to ${currentTarget.displayName}`, 'success');
        setIsPromptModalOpen(false);
        onClose();
      }
    } catch (err) {
      showToast(`Failed to send to agent: ${err}`, 'error');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className={`preview-annotation-container${isCapturing ? ' is-capturing' : ''}`} aria-label="Web page drawing overlay">
      {items.some((item) => item.type === 'text') && !isPromptModalOpen && (
        <section className="annotation-notes-tray" aria-label="Page annotations" onPointerDown={(event) => event.stopPropagation()}>
          <strong>Page notes</strong>
          {items.map((item, index) => item.type === 'text' ? (
            <div className="annotation-note-row" key={index}>
              <input aria-label={`Annotation ${index + 1}`} value={item.text} onChange={(event) => {
                const text = event.target.value;
                setItems((previous) => previous.map((entry, position) => position === index && entry.type === 'text' ? { ...entry, text } : entry));
              }} />
              <button type="button" aria-label={`Remove annotation ${index + 1}`} onClick={() => setItems((previous) => previous.filter((_, position) => position !== index))}>Remove</button>
            </div>
          ) : null)}
        </section>
      )}
      {/* Floating Drawing Toolbar */}
      <div className="annotation-toolbar" role="toolbar" aria-label="Drawing tools">
        {/* Tools */}
        <div className="annotation-group">
          <button
            type="button"
            className={`annotation-tool-btn${activeTool === 'pen' ? ' active' : ''}`}
            aria-pressed={activeTool === 'pen'}
            onClick={() => setActiveTool('pen')}
            title="Freehand Draw (Pen)"
            aria-label="Pen tool"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              <path d="M2 2l7.586 7.586" />
              <circle cx="11" cy="11" r="2" />
            </svg>
            <span>Draw</span>
          </button>

          <button
            type="button"
            className={`annotation-tool-btn${activeTool === 'arrow' ? ' active' : ''}`}
            aria-pressed={activeTool === 'arrow'}
            onClick={() => setActiveTool('arrow')}
            title="Arrow tool (click and drag to point)"
            aria-label="Arrow tool"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="19" x2="19" y2="5" />
              <polyline points="9 5 19 5 19 15" />
            </svg>
            <span>Arrow</span>
          </button>

          <button
            type="button"
            className={`annotation-tool-btn${activeTool === 'rectangle' ? ' active' : ''}`}
            aria-pressed={activeTool === 'rectangle'}
            onClick={() => setActiveTool('rectangle')}
            title="Rectangle / Box tool"
            aria-label="Rectangle tool"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <span>Box</span>
          </button>

          <button
            type="button"
            className={`annotation-tool-btn${activeTool === 'text' ? ' active' : ''}`}
            aria-pressed={activeTool === 'text'}
            onClick={() => setActiveTool('text')}
            title="Text note (click on page to write)"
            aria-label="Text note tool"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 7 4 4 20 4 20 7" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
            <span>Text</span>
          </button>
        </div>

        <div className="annotation-divider" />

        {/* Color Palette */}
        <div className="annotation-colors" role="radiogroup" aria-label="Color palette">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`annotation-color-dot${activeColor === c.color ? ' active' : ''}`}
              style={{ backgroundColor: c.color }}
              onClick={() => setActiveColor(c.color)}
              role="radio"
              aria-checked={activeColor === c.color}
              title={c.label}
              aria-label={c.label}
            />
          ))}
        </div>

        <div className="annotation-divider" />

        {/* Stroke Sizes */}
        <div className="annotation-strokes">
          {STROKE_WIDTHS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`annotation-stroke-btn${activeStrokeWidth === s.width ? ' active' : ''}`}
              onClick={() => setActiveStrokeWidth(s.width)}
              aria-label={s.label}
              aria-pressed={activeStrokeWidth === s.width}
              title={s.label}
            >
              <span
                className="stroke-indicator"
                style={{ height: `${s.width}px`, backgroundColor: activeColor }}
              />
            </button>
          ))}
        </div>

        <div className="annotation-divider" />

        {/* Actions */}
        <div className="annotation-group">
          <button
            type="button"
            className="annotation-action-btn"
            onClick={handleUndo}
            disabled={items.length === 0}
            title={items.length ? "Undo last annotation" : "Draw or add a note to enable Undo"}
            aria-label="Undo last annotation"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
            </svg>
          </button>

          <button
            type="button"
            className="annotation-action-btn"
            onClick={handleClear}
            disabled={items.length === 0}
            title={items.length ? "Clear all drawings" : "No drawings to clear"}
            aria-label="Clear all drawings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
        </div>

        <div className="annotation-divider" />

        {/* Send to Agent Button */}
        <button
          type="button"
          className="annotation-send-btn"
          onClick={handleOpenSendModal}
          disabled={items.length === 0 || isCapturing}
          title={items.length ? "Send drawing and prompt to AI agent" : "Draw or add a note before sending"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
          </svg>
          <span>Send to Agent</span>
        </button>

        {/* Exit Button */}
        <button
          type="button"
          className="annotation-close-btn"
          onClick={onClose}
          title="Exit draw mode"
          aria-label="Exit draw mode"
        >
          <BrowserActionIcon name="close" />
        </button>
      </div>

      {/* Drawing Canvas */}
      <canvas
        ref={canvasRef}
        className="annotation-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          setIsDrawing(false);
          startPointRef.current = null;
          currentPathRef.current = [];
          redrawCanvas();
        }}
      />

      {/* Inline Text Input overlay when clicking with Text tool */}
      {textInputPos && (
        <div
          className="annotation-inline-text-wrapper"
          style={{ left: `${textInputPos.x}px`, top: `${textInputPos.y - 12}px` }}
        >
          <input
            ref={textInputRef}
            type="text"
            className="annotation-inline-text-input"
            value={textInputValue}
            onChange={(e) => setTextInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') {
                setTextInputPos(null);
                setTextInputValue('');
              }
            }}
            onBlur={commitText}
            placeholder="Type note and press Enter…"
          />
        </div>
      )}

      {/* Send Prompt & Target Selector Modal */}
      {isPromptModalOpen && (
        <div className="annotation-modal-backdrop" onClick={() => setIsPromptModalOpen(false)}>
          <div className="annotation-modal-card" role="dialog" aria-label="Send drawing to agent" onClick={(e) => e.stopPropagation()}>
            <div className="annotation-modal-header">
              <div className="annotation-modal-title">
                <span className="annotation-modal-icon"><BrowserActionIcon name="draw" /></span>
                <h3>Send Drawing to AI Agent</h3>
              </div>
              <button
                type="button"
                className="annotation-modal-close"
                onClick={() => setIsPromptModalOpen(false)}
              >
                <BrowserActionIcon name="close" />
              </button>
            </div>

            <div className="annotation-modal-body">
              {/* Snapshot thumbnail */}
              {compositeSnapshot && (
                <div className="annotation-snapshot-preview" title="Composite drawing on site">
                  <img src={compositeSnapshot} alt="Site drawing snapshot" />
                  <span className="annotation-snapshot-tag">Annotated Browser</span>
                </div>
              )}

              {/* Agent Target Row */}
              <div className="annotation-target-section">
                <span className="annotation-section-label">Target Agent:</span>
                {availableTargets.length === 1 && currentTarget && (
                  <div className="annotation-auto-target-pill" title="Automatically selected single open agent">
                    <span className="annotation-target-dot" />
                    <span className="annotation-target-name">{currentTarget.name}</span>
                    <span className={`annotation-target-kind ${currentTarget.isChatView ? 'chat' : 'terminal'}`}>
                      {currentTarget.isChatView ? 'Chat UI' : 'Terminal'}
                    </span>
                    <span className="annotation-auto-chip">Auto-targeted</span>
                  </div>
                )}

                {availableTargets.length > 1 && (
                  <div className="annotation-target-dropdown-wrap">
                  <Dropdown
                    options={availableTargets.map((target) => ({ value: String(target.id), label: target.name, sublabel: target.isChatView ? 'Chat' : 'Terminal' }))}
                    value={currentTarget ? String(currentTarget.id) : ''}
                    onChange={(value) => setSelectedTargetId(Number(value))}
                    placeholder="Choose an agent"
                    ariaLabel="Target AI agent"
                    boundarySelector=".annotation-modal-card"
                    disableTooltips
                  />
                  </div>
                )}

                {availableTargets.length === 0 && (
                  <div className="annotation-no-target-warning">
                    <span>No AI agent is currently running. Start an agent in Terminal to send directly.</span>
                  </div>
                )}
              </div>

              {/* Instructions Textarea */}
              <div className="annotation-prompt-group">
                <label htmlFor="annotation-prompt-input">Instructions for the agent:</label>
                <textarea
                  id="annotation-prompt-input"
                  rows={3}
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  placeholder="e.g. Please fix the styling defect and adjust the button placement as drawn..."
                />
              </div>

              {/* Quick Prompt Chips */}
              <div className="annotation-quick-prompts">
                <span className="annotation-quick-label">Suggestions:</span>
                <div className="annotation-chip-list">
                  {QUICK_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="annotation-quick-chip"
                      onClick={() => setUserPrompt(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="annotation-modal-footer">
              <button
                type="button"
                className="annotation-btn-secondary"
                onClick={handleCopyImage}
                title="Copy drawing base64"
              >
                <BrowserActionIcon name="copy" /> Copy Image
              </button>

              <button
                type="button"
                className="annotation-btn-primary"
                onClick={handleSendToAgent}
                disabled={!currentTarget || isSending}
                title={!currentTarget ? 'No agent running' : 'Send to selected agent'}
              >
                {isSending ? 'Sending…' : `Send to ${currentTarget ? currentTarget.name : 'Agent'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Helper function to draw crisp arrow with arrowhead */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  lineWidth: number
) {
  const headLen = Math.max(12, lineWidth * 3.5);
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead triangle
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}
