import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DesignModePanel from './DesignModePanel';
import type { SelectedElementInfo } from '$lib/services/element-prompt';

vi.mock('$lib/utils/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/stores/notification', () => ({
  showToast: vi.fn(),
}));

const mockElement: SelectedElementInfo = {
  selector: 'div.hero > button.cta-btn',
  tag: 'BUTTON',
  text: 'Get Started Today',
  html: '<button class="cta-btn" type="button">Get Started Today</button>',
  attributes: { class: 'cta-btn', type: 'button', id: 'start-now' },
  classes: ['cta-btn'],
  styles: {
    display: 'inline-flex',
    backgroundColor: 'rgb(59, 130, 246)',
    color: 'rgb(255, 255, 255)',
    padding: '12px 24px',
    borderRadius: '8px',
  },
  ancestorPath: ['html', 'body', 'main', 'div.hero', 'button.cta-btn'],
  page: { url: 'http://localhost:3000/landing', title: 'Landing Page' },
  rect: { x: 100, y: 250, width: 180, height: 48 },
};

describe('DesignModePanel (Orca Design Mode)', () => {
  it('renders element tag, selector, and dimensions in header', () => {
    const handleClose = vi.fn();
    const handleReselect = vi.fn();
    const handleSend = vi.fn();

    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        onClose={handleClose}
        onReselect={handleReselect}
        onSendToAgent={handleSend}
      />
    );

    expect(screen.getByText('<button>')).toBeDefined();
    expect(screen.getByText('div.hero > button.cta-btn')).toBeDefined();
    expect(screen.getByText('180 × 48 px')).toBeDefined();
    expect(screen.getByText('Visual Snapshot')).toBeDefined();
  });

  it('renders breadcrumbs / hierarchy correctly', () => {
    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl={null}
        onClose={vi.fn()}
        onReselect={vi.fn()}
        onSendToAgent={vi.fn()}
      />
    );

    expect(screen.getByText('div.hero')).toBeDefined();
    expect(screen.getByText('button.cta-btn')).toBeDefined();
  });

  it('switches between tabs (Prompt, Styles, HTML, Attributes)', () => {
    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl={null}
        onClose={vi.fn()}
        onReselect={vi.fn()}
        onSendToAgent={vi.fn()}
      />
    );

    // Switch to Computed Styles tab
    const stylesTabBtn = screen.getByRole('tab', { name: /Computed Styles/i });
    fireEvent.click(stylesTabBtn);
    expect(screen.getByText('display:')).toBeDefined();
    expect(screen.getByText('inline-flex')).toBeDefined();

    // Switch to HTML tab
    const htmlTabBtn = screen.getByRole('tab', { name: /HTML/i });
    fireEvent.click(htmlTabBtn);
    expect(screen.getByText('<button class="cta-btn" type="button">Get Started Today</button>')).toBeDefined();

    // Switch to Attributes tab
    const attrsTabBtn = screen.getByRole('tab', { name: /Attributes/i });
    fireEvent.click(attrsTabBtn);
    expect(screen.getByText('id=')).toBeDefined();
    expect(screen.getByText('"start-now"')).toBeDefined();
  });

  it('appends preset prompt chips when clicked', () => {
    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl={null}
        onClose={vi.fn()}
        onReselect={vi.fn()}
        onSendToAgent={vi.fn()}
      />
    );

    const stylingChip = screen.getByText('🎨 Styling & Colors');
    fireEvent.click(stylingChip);

    const textarea = screen.getByPlaceholderText(/e\.g\. Change background to indigo/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain('Update the styling and color palette of this element');
  });

  it('calls onSendToAgent with formatted prompt and screenshot on send', () => {
    const handleSend = vi.fn();
    const fakeScreenshot = 'data:image/png;base64,fake';

    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl={fakeScreenshot}
        onClose={vi.fn()}
        onReselect={vi.fn()}
        onSendToAgent={handleSend}
      />
    );

    const textarea = screen.getByPlaceholderText(/e\.g\. Change background to indigo/i);
    fireEvent.change(textarea, { target: { value: 'Make this button primary blue with 8px radius' } });

    const sendBtn = screen.getByRole('button', { name: /Send to Agent/i });
    fireEvent.click(sendBtn);

    expect(handleSend).toHaveBeenCalledTimes(1);
    const [sentPrompt, sentScreenshot] = handleSend.mock.calls[0];
    expect(sentPrompt).toContain('Task: Make this button primary blue with 8px radius');
    expect(sentPrompt).toContain('Selected `div.hero > button.cta-btn`');
    expect(sentPrompt).toContain('Computed styles:');
    expect(sentScreenshot).toBe(fakeScreenshot);
  });

  it('calls onReselect and onClose callbacks', () => {
    const handleClose = vi.fn();
    const handleReselect = vi.fn();

    render(
      <DesignModePanel
        elementInfo={mockElement}
        screenshotUrl={null}
        onClose={handleClose}
        onReselect={handleReselect}
        onSendToAgent={vi.fn()}
      />
    );

    const reselectBtn = screen.getByRole('button', { name: /Reselect/i });
    fireEvent.click(reselectBtn);
    expect(handleReselect).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByLabelText('Close Design Mode panel');
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
