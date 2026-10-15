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
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Shortcut profile"]')!.value).toBe(profile);
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Remote shortcut"]')!;
      await act(async () => { select.value = choice; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(send).not.toHaveBeenCalled();
      expect(container.querySelector('p')!.textContent).toContain(description);
      await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send shortcut')!.click());
      expect(send).toHaveBeenCalledWith([choice.toLowerCase()]);
      await act(async () => root.render(<HerdrShortcuts kind={kind} disabled onSend={send} />));
      expect([...container.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
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
});
