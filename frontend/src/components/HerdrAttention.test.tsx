import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HerdrAttention } from './HerdrAttention';
import type { HerdrAttention as Notice } from '../hooks/useHerdrAttention';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps focus and work intact until View is clicked; Later retains a pending indicator', async () => {
  const open = vi.fn();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function Screen() {
    const [notices, setNotices] = useState<Notice[]>([{ id: 1, backendId: 'b1', target: 'reviewer',
      kind: 'blocked', name: 'reviewer', message: 'Waiting for your input.', acknowledged: false }]);
    return <><input aria-label="Current work" defaultValue="unsaved work" />
      <HerdrAttention notices={notices} agents={[]} isMobile={false} onOpen={open}
        onAcknowledge={() => setNotices((prev) => prev.map((n) => ({ ...n, acknowledged: true })))} /></>;
  }
  try {
    await act(async () => root.render(<Screen />));
    const input = container.querySelector('input')!; input.focus();
    expect(open).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
    await act(async () => button('Later').click());
    expect(container.textContent).toContain('1 need attention');
    expect(container.textContent).not.toContain('Waiting for your input.');
    expect(input.value).toBe('unsaved work'); expect(open).not.toHaveBeenCalled();
    await act(async () => button('Show').click());
    await act(async () => button('View in Herdr').click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ backendId: 'b1', target: 'reviewer' }));
  } finally { act(() => root.unmount()); container.remove(); }
});
