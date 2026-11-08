import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { PortsView } from './PortsView';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(), addForward: vi.fn(), deleteForward: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent: api.AgentInfo = {
  id: 'a1', name: 'Agent', status: 'online', last_seen: 0, rtt_ms: null, inflight: 0,
  resource_revision: 0, pending_resource_update: false, last_config_error: null,
  roots: [], collections: [], collections_revision: 0, pending_collections_update: false,
  capabilities: { port_forward: true }, forwards: [], forwards_revision: 0, pending_forwards_update: false,
};
let host: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const width = window.innerWidth;

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.addForward).mockResolvedValue({ ok: true, state: 'applied' });
  vi.mocked(api.deleteForward).mockResolvedValue({ ok: true, state: 'applied' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.innerWidth = width;
  vi.restoreAllMocks();
});
async function render(value = agent) {
  await act(async () => root.render(<PortsView key={value.id} agent={value} onRefresh={refresh} />));
}
function input(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it.each([false, undefined])('explains unavailable capability %s without showing controls', async (capability) => {
  await render({ ...agent, capabilities: { port_forward: capability } });
  expect(host.textContent).toContain('Upgrade the Agent');
  expect(host.textContent).toContain('FILEBOX_AGENT_PORT_FORWARD=off');
  expect(host.querySelector('form')).toBeNull();
});

it('shows an empty state and adds an optional default name', async () => {
  await render();
  expect(host.textContent).toContain('No ports yet');
  input('Port', '9001');
  await submit();
  expect(api.addForward).toHaveBeenCalledExactlyOnceWith('a1', { port: 9001, name: 'Port 9001' });
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.querySelector('input')?.value).toBe('');
});

it.each(['', '0', '65536', '1.5'])('validates invalid port %j without sending', async (port) => {
  await render();
  input('Port', port);
  await submit();
  expect(api.addForward).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('1 to 65535');
});

it.each(['1', '65535'])('accepts boundary port %s and trims the supplied name', async (port) => {
  await render();
  input('Port', port);
  input('Name (optional)', ' Notebook ');
  await submit();
  expect(api.addForward).toHaveBeenCalledWith('a1', { port: Number(port), name: 'Notebook' });
});

it('lists safe new-tab links, copies an absolute link and deletes the selected port', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python' }, { port: 8888, name: 'Notebook' }] });
  const link = host.querySelector('a')!;
  expect(link.getAttribute('href')).toBe('/_fwd/a1/9001/');
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
  expect(host.textContent).toContain(':8888');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy link for Python"]')!.click());
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/_fwd/a1/9001/`);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete Notebook"]')!.click());
  expect(api.deleteForward).toHaveBeenCalledExactlyOnceWith('a1', 8888);
});

it('rejects duplicate ports and retains the draft on Agent rejection', async () => {
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python' }] });
  input('Port', '9001');
  await submit();
  expect(api.addForward).not.toHaveBeenCalled();
  expect(host.textContent).toContain('already listed');
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Cannot persist forward list' });
  input('Port', '9002');
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Cannot persist forward list');
  expect(host.querySelector('input')?.value).toBe('9002');
  expect(refresh).toHaveBeenCalledOnce();
});

it('reports clipboard failures instead of claiming the link was copied', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python' }] });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy link for Python"]')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not copy the link');
});

it('shows pending/offline and config errors, then updates from refreshed Agent metadata', async () => {
  const forwards = [{ port: 9001, name: 'Python' }];
  await render({ ...agent, forwards, status: 'offline', pending_forwards_update: true, last_config_error: 'Rejected config' });
  expect(host.textContent).toContain('Changes will sync on reconnect');
  expect(host.textContent).toContain('Rejected config');
  expect(host.querySelector('a')).toBeNull();
  await render({ ...agent, forwards, pending_forwards_update: true });
  expect(host.textContent).toContain('Pending sync');
  await render({ ...agent, forwards, forwards_revision: 1 });
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('a')).not.toBeNull();
});

it('queues offline edits, disables mutations while saving, and resets the form for another Agent', async () => {
  let finish!: (response: api.DesiredStateResponse) => void;
  vi.mocked(api.addForward).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await render({ ...agent, status: 'offline' });
  input('Port', '9001');
  await submit();
  expect(host.querySelector('input')?.disabled).toBe(true);
  expect(host.textContent).toContain('Saving…');
  await act(async () => finish({ ok: true, state: 'pending_agent_reconnect' }));
  expect(refresh).toHaveBeenCalledOnce();
  input('Name (optional)', 'Draft');
  await render({ ...agent, id: 'a2' });
  expect(host.querySelector<HTMLInputElement>('[aria-label="Name (optional)"]')?.value).toBe('');
});

it('keeps compact wrapping controls and a scrollable view on mobile', async () => {
  window.innerWidth = 375;
  await render({ ...agent, forwards: [{ port: 9001, name: 'A very long local service name' }] });
  expect(host.querySelector('section')?.style.padding).toBe('16px');
  expect(host.querySelector('section')?.style.overflowY).toBe('auto');
  expect(host.querySelector('form')?.style.flexWrap).toBe('wrap');
  expect(host.querySelector('a')?.style.height).toBe('30px');
});
