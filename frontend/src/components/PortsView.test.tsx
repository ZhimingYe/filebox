import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { PortsView } from './PortsView';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(), addForward: vi.fn(), deleteForward: vi.fn(), setForwardPrefix: vi.fn(),
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
  vi.mocked(api.setForwardPrefix).mockResolvedValue({ ok: true, state: 'applied' });
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
  expect(host.textContent).toContain('Port forwarding is unavailable');
  expect(host.textContent).not.toContain('FILEBOX_AGENT');
  expect(host.querySelector('form')).toBeNull();
});

it('shows an empty state and adds an optional default name', async () => {
  await render();
  expect(host.textContent).toContain('No ports yet');
  expect(host.textContent).not.toContain('trusted_ports');
  expect(host.textContent).toContain('Only forward apps you trust');
  expect(host.textContent).toContain('Hub origin');
  expect(host.textContent).toContain('running code and writing files');
  expect(host.textContent).toContain('Anyone signed in to this Hub');
  expect(host.textContent).not.toContain('Allowed ports');
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
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python', trusted: true }, { port: 8888, name: 'Notebook', trusted: true }] });
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

it.each([false, undefined])('disables untrusted or legacy forwards (%s) without displaying an allowed-ports policy', async (trusted) => {
  await render({ ...agent, forwards: [{ port: 9001, name: 'App', trusted }] });
  expect(host.textContent).toContain('Not trusted by agent');
  expect(host.querySelector('a')).toBeNull();
  const open = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Open');
  expect(open?.disabled).toBe(true);
  expect(host.textContent).not.toContain('Allowed ports');
  await render({ ...agent, forwards: [{ port: 9001, name: 'App', trusted: true }] });
  expect(host.textContent).not.toContain('Not trusted by agent');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/_fwd/a1/9001/');
});

it('shows the Agent trust rejection and retains the add draft', async () => {
  const message = "Port 9002 is not trusted by this agent; add it to the agent's trusted_ports.";
  vi.mocked(api.addForward).mockRejectedValue({ error: 'port_not_trusted', message });
  await render();
  input('Port', '9002');
  await submit();
  expect(api.addForward).toHaveBeenCalledExactlyOnceWith('a1', { port: 9002, name: 'Port 9002' });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Port"]')?.value).toBe('9002');
});

it('reports clipboard failures instead of claiming the link was copied', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python' }] });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy link for Python"]')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not copy the link');
});

it('shows pending/offline without a pre-existing config error, then updates from refreshed Agent metadata', async () => {
  const forwards = [{ port: 9001, name: 'Python', trusted: true }];
  await render({ ...agent, forwards, status: 'offline', pending_forwards_update: true, last_config_error: 'Rejected config' });
  expect(host.textContent).toContain('Changes will sync on reconnect');
  expect(host.textContent).not.toContain('Rejected config');
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
  await render({ ...agent, forwards: [{ port: 9001, name: 'A very long local service name', trusted: true }] });
  expect(host.querySelector('section')?.style.padding).toBe('16px');
  expect(host.querySelector('section')?.style.overflowY).toBe('auto');
  expect(host.querySelector('form')?.style.flexWrap).toBe('wrap');
  expect(host.querySelector('a')?.style.height).toBe('30px');
});

it('adds a configured base path from Advanced and resets its checkbox on success', async () => {
  await render();
  expect(host.querySelector('details summary')?.textContent).toBe('Advanced');
  input('Port', '8888');
  await act(async () => host.querySelector<HTMLInputElement>('details input[type="checkbox"]')!.click());
  await submit();
  expect(api.addForward).toHaveBeenCalledWith('a1', { port: 8888, name: 'Port 8888', keep_prefix: true });
  expect(host.querySelector<HTMLInputElement>('details input[type="checkbox"]')?.checked).toBe(false);
});

it('toggles existing base paths, copies the prefix, and reflects rejection without losing the current value', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python', keep_prefix: true }] });
  const toggle = host.querySelector<HTMLInputElement>('[aria-label="App uses this base path for Python"]')!;
  expect(toggle.checked).toBe(true);
  await act(async () => toggle.click());
  expect(api.setForwardPrefix).toHaveBeenCalledExactlyOnceWith('a1', 9001, false);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy base path for Python"]')!.click());
  expect(writeText).toHaveBeenCalledWith('/_fwd/a1/9001/');
  vi.mocked(api.setForwardPrefix).mockRejectedValue({ message: 'Cannot persist base path' });
  await act(async () => toggle.click());
  expect(toggle.checked).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Cannot persist base path');
});

it('keeps row errors local and clears clipboard failures after a successful retry', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python', trusted: true }] });
  const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy base path for Python"]')!;
  await act(async () => copy.click());
  expect(host.querySelector('form [role="alert"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not copy the base path.');
  await act(async () => copy.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('allows drafting during row saves without claiming the add form is saving', async () => {
  let finish!: (response: api.DesiredStateResponse) => void;
  vi.mocked(api.deleteForward).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python', trusted: true }] });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete Python"]')!.click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Port"]')?.disabled).toBe(false);
  expect(host.querySelector('form button')?.textContent).toBe('Add port');
  input('Port', '9002');
  await submit();
  expect(api.addForward).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true, state: 'applied' }));
  expect(host.querySelector<HTMLInputElement>('[aria-label="Port"]')?.value).toBe('9002');
});

it('previews the canonical base path and does not preview invalid ports', async () => {
  await render();
  input('Port', '009001');
  expect(host.querySelector('details code')?.textContent).toBe('/_fwd/a1/9001/');
  input('Port', '65536');
  expect(host.querySelector('details code')?.textContent).toBe('/_fwd/a1/<port>/');
});

it('does not duplicate a rejection echoed through Agent metadata', async () => {
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Rejected port' });
  await render();
  input('Port', '9001');
  await submit();
  await render({ ...agent, last_config_error: 'Rejected port' });
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('form [role="alert"]')?.textContent).toBe('Rejected port');
});

it('dismisses an add error and its metadata echo', async () => {
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Rejected port' });
  await render();
  input('Port', '9001');
  await submit();
  await render({ ...agent, last_config_error: 'Rejected port' });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('dismisses a row error without removing the row', async () => {
  vi.mocked(api.setForwardPrefix).mockRejectedValue({ message: 'Cannot save prefix' });
  await render({ ...agent, forwards: [{ port: 9001, name: 'Python', trusted: true }] });
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="App uses this base path for Python"]')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Cannot save prefix');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[aria-label="Delete Python"]')).not.toBeNull();
});

it.each(['Port', 'Name (optional)'])('clears the add error when editing %s without exposing its metadata echo', async (field) => {
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Rejected port' });
  await render();
  input('Port', '9001');
  await submit();
  await render({ ...agent, last_config_error: 'Rejected port' });
  input(field, field === 'Port' ? '9002' : 'Draft');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('ignores pre-existing config errors on mount and after remount', async () => {
  const value = { ...agent, last_config_error: 'Old rejection' };
  await render(value);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => root.render(null));
  await render(value);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('shows a newly arriving error once, allows dismissal, and shows a different arrival', async () => {
  const value = { ...agent, last_config_error: 'Old rejection' };
  await render(value);
  await render({ ...value, last_config_error: 'New rejection' });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('New rejection');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click());
  await render({ ...value, last_config_error: 'New rejection', rtt_ms: 5 });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await render({ ...value, last_config_error: 'Another rejection' });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Another rejection');
});

it('does not retain local or async notices across remounts', async () => {
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Rejected port' });
  await render();
  input('Port', '9001');
  await submit();
  expect(host.querySelector('form [role="alert"]')?.textContent).toBe('Rejected port');
  await act(async () => root.render(null));
  await render({ ...agent, last_config_error: 'Rejected port' });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await render({ ...agent, last_config_error: 'Async rejection' });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Async rejection');
  await act(async () => root.render(null));
  await render({ ...agent, last_config_error: 'Async rejection' });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('does not redisplay a late metadata echo after the local error was dismissed', async () => {
  vi.mocked(api.addForward).mockRejectedValue({ message: 'Rejected port' });
  await render();
  input('Port', '9001');
  await submit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click());
  await render({ ...agent, last_config_error: 'Rejected port' });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
