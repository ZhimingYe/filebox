import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HerdrShortcuts } from './HerdrShortcuts';
import { COMMON_KEYS, PROFILE_KEYS, QUICK_KEYS } from '../lib/herdrShortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('Herdr shortcut profiles', () => {
  it.each([['pi', 'pi', 'Ctrl+L', 'Choose model'], ['claude-code', 'claude', 'Ctrl+O', 'Open transcript'],
    ['codex', 'codex', 'Ctrl+T', 'Open transcript pager']])('explains and sends %s defaults only on click', async (kind, profile, choice, description) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const send = vi.fn();
    try {
      await act(async () => root.render(<HerdrShortcuts kind={kind} disabled={false} onSend={send} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More shortcuts"]')!.click());
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Shortcut profile"]')!.value).toBe(profile);
      expect(send).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${choice}: ${description}"]`)!.click());
      expect(send).toHaveBeenCalledWith([choice.toLowerCase()]);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => root.render(<HerdrShortcuts kind={kind} disabled onSend={send} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More shortcuts"]')!.click());
      expect([...container.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') !== 'More shortcuts').every((b) => b.disabled)).toBe(true);
    } finally { act(() => root.unmount()); }
  });

  it('keeps every advertised key within the shared Hub/Agent whitelist', () => {
    const source = readFileSync('../crates/protocol/src/herdr.rs', 'utf8');
    const allowed = [...source.split('const ALLOWED_KEYS:')[1].split('];')[0].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    for (const shortcut of [...QUICK_KEYS, ...COMMON_KEYS, ...Object.values(PROFILE_KEYS).flat()]) {
      expect(shortcut.keys.length).toBeLessThanOrEqual(8);
      for (const key of shortcut.keys) expect(allowed, shortcut.label).toContain(key);
    }
  });

  it('opens and dismisses the keyboard without sending input or exposing unsupported navigation keys', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const send = vi.fn();
    try {
      await act(async () => root.render(<HerdrShortcuts kind="claude" disabled={false} onSend={send} />));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More shortcuts"]')!;
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => trigger.click());
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.textContent).not.toMatch(/Ctrl\+End|PageUp|PageDown|Delete/);
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      await act(async () => trigger.click());
      await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(send).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); container.remove(); }
  });
});
