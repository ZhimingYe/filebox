import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../api/client';
import { HerdrIntro } from './HerdrIntro';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('introduces an unavailable CLI on first open and links setup and settings', async () => {
  const openSettings = vi.fn();
  const agent = { name: 'Lab box', status: 'online', capabilities: { herdr_settings: true, herdr_enabled: true } } as AgentInfo;
  await act(async () => root.render(<HerdrIntro agent={agent} onOpenSettings={openSettings} />));
  expect(container.querySelector('h1')?.textContent).toBe('Meet Herdr');
  expect(container.textContent).toContain('send prompts or approval keys');
  expect(container.textContent).toContain('Set up Herdr on Lab box');
  expect(container.textContent).toContain('FILEBOX_AGENT_HERDR');
  expect(container.querySelector('a')?.href).toBe('https://github.com/herdrdev/herdr');
  await act(async () => container.querySelector('button')!.click());
  expect(openSettings).toHaveBeenCalledOnce();
});

it('does not mistake a disabled integration for a missing installation', async () => {
  const agent = { name: 'Lab box', capabilities: { herdr_settings: true, herdr_enabled: false } } as AgentInfo;
  await act(async () => root.render(<HerdrIntro agent={agent} onOpenSettings={vi.fn()} />));
  expect(container.querySelector('h1')?.textContent).toBe('Herdr is turned off');
  expect(container.textContent).toContain('does not stop Herdr');
  expect(container.querySelector('ol')).toBeNull();
});
