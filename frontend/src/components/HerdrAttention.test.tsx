import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HerdrAttention } from './HerdrAttention';
import type { HerdrAttention as Notice } from '../hooks/useHerdrAttention';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['Later', 'Close Herdr reminders'])('%s removes the whole banner without disturbing work; a new episode can notify again', async (dismiss) => {
  const open = vi.fn();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let raiseNewEpisode = () => {};
  function Screen() {
    const [notices, setNotices] = useState<Notice[]>([{ id: 1, backendId: 'b1', target: 'reviewer',
      kind: 'blocked', name: 'reviewer', message: 'Waiting for your input.', acknowledged: false }]);
    raiseNewEpisode = () => setNotices((prev) => prev.map((n) => ({ ...n, id: n.id + 1, acknowledged: false })));
    return <><input aria-label="Current work" defaultValue="unsaved work" />
      <HerdrAttention notices={notices} agents={[]} isMobile={false} onOpen={open}
        onAcknowledge={() => setNotices((prev) => prev.map((n) => ({ ...n, acknowledged: true })))} /></>;
  }
  try {
    await act(async () => root.render(<Screen />));
    const input = container.querySelector('input')!; input.focus();
    expect(open).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label') === text)!;
    await act(async () => button(dismiss).click());
    expect(container.querySelector('aside')).toBeNull();
    expect(container.textContent).not.toContain('need attention');
    expect(container.textContent).not.toContain('Waiting for your input.');
    expect(input.value).toBe('unsaved work'); expect(open).not.toHaveBeenCalled();
    await act(async () => raiseNewEpisode());
    expect(container.querySelector('aside')).not.toBeNull();
    await act(async () => button('View in Herdr').click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ backendId: 'b1', target: 'reviewer' }));
    expect(container.querySelector('aside')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});
