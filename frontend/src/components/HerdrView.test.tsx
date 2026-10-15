import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { HerdrView } from './HerdrView';

vi.mock('../api/client', async (original) => {
  const actual = await original<typeof api>();
  return { ...actual, herdrCommand: vi.fn() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const agent = {
  id: 'agent-1',
  name: 'Lab box',
  capabilities: { herdr: true },
} as api.AgentInfo;

const listed = {
  req_id: 'h1',
  status: { installed: true, reachable: true, version: '1.4.0' },
  agents: [{
    target: 'reviewer',
    name: 'reviewer',
    kind: 'codex',
    status: 'working' as const,
    pane_id: 'w1:p2',
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    cwd: '/repo',
    focused: false,
  }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') return listed;
    if (body.op === 'read') return { req_id: 'r1', output: 'latest pane output' };
    if (body.op === 'prompt') return { req_id: 'p1', agent: listed.agents[0] };
    if (body.op === 'send_keys') return { req_id: 'k1' };
    return { req_id: 'x' };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  window.innerWidth = 1024;
});

async function render() {
  await act(async () => root.render(<HerdrView agent={agent} />));
}

async function toggleSetting(label: string) {
  await act(async () => button('Herdr settings').click());
  await act(async () => [...container.querySelectorAll('label')].find((item) => item.textContent?.includes(label))!.querySelector('input')!.click());
  await act(async () => button('Herdr settings').click());
}

async function typePrompt(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label)!;
}

describe('HerdrView', () => {
  it('reports status and opens a notified agent without locking later selection', async () => {
    const report = vi.fn();
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [listed.agents[0], { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] }
      : { req_id: 'r', output: body.target });
    await act(async () => root.render(<HerdrView agent={agent} onStatus={report}
      focusRequest={{ target: 'writer', nonce: 1 }} />));
    expect(report).toHaveBeenCalledWith(agent.id, expect.objectContaining({ agents: expect.any(Array) }));
    expect(container.querySelector('textarea')!.getAttribute('aria-label')).toBe('Prompt for writer');
    const reviewer = [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent?.includes('reviewer'))!;
    await act(async () => reviewer.click());
    expect(container.querySelector('textarea')!.getAttribute('aria-label')).toBe('Prompt for reviewer');
  });

  it('keeps prompt drafts separate when switching agents', async () => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [listed.agents[0], { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] }
      : { req_id: 'r', output: body.target });
    await render();
    await typePrompt('review draft');
    const card = (target: string) => [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent?.includes(target))!;
    await act(async () => card('writer').click());
    expect(container.querySelector('textarea')!.value).toBe('');
    await typePrompt('writer draft');
    await act(async () => card('reviewer').click());
    expect(container.querySelector('textarea')!.value).toBe('review draft');
  });

  it('shows a completion hint without refreshing output on status polls', async () => {
    vi.useFakeTimers();
    let seq = 1;
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [{ ...listed.agents[0], status: 'idle', completion_seq: seq }] }
      : { req_id: 'r', output: `answer ${seq}` });
    await render();
    seq = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(container.querySelector('pre')!.textContent).toBe('answer 1');
    expect(container.textContent).toContain('Status changed');
    await act(async () => button('Refresh output').click());
    expect(container.querySelector('pre')!.textContent).toBe('answer 2');
  });

  it('stops waiting without resubmitting a prompt or discarding its draft', async () => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, signal) => {
      if (body.op === 'status') return listed;
      if (body.op === 'read') return { req_id: 'r', output: 'working' };
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    await render();
    await typePrompt('long task');
    await toggleSetting('Wait for result');
    await act(async () => button('Send').click());
    expect(button('Stop waiting')).toBeDefined();
    await act(async () => button('Stop waiting').click());
    expect(button('Send').disabled).toBe(false);
    expect(container.querySelector('textarea')!.value).toBe('long task');
    expect(container.textContent).toContain('Already submitted input may still be running');
    expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'prompt')).toHaveLength(1);
  });

  it('validates the UTF-8 prompt size before sending', async () => {
    await render();
    await typePrompt('中'.repeat(11000));
    expect(button('Send').disabled).toBe(true);
    expect(container.textContent).toContain('32 KiB limit');
    expect(vi.mocked(api.herdrCommand).mock.calls.some(([, body]) => body.op === 'prompt')).toBe(false);
  });

  it('clears a read error after the next successful refresh', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
      if (body.op === 'status') return { ...listed, agents: [{ ...listed.agents[0], status: 'idle' }] };
      if (++reads === 1) throw { error: 'herdr_timeout' };
      return { req_id: 'r', output: 'recovered output' };
    });
    await render();
    expect(container.textContent).toContain('timed out');
    await act(async () => button('Refresh output').click());
    expect(container.textContent).not.toContain('timed out');
    expect(container.textContent).toContain('recovered output');
  });

  it('offers navigation keys for a blocked agent while disabling prompt submission', async () => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [{ ...listed.agents[0], status: 'blocked' }] }
      : { req_id: 'r', output: 'Choose an option' });
    await render();
    await typePrompt('cannot submit yet');
    expect(button('Send').disabled).toBe(true);
    await act(async () => button('Down').click());
    expect(api.herdrCommand).toHaveBeenCalledWith(agent.id,
      { op: 'send_keys', target: 'reviewer', keys: ['down'] }, expect.any(AbortSignal), 15_000);
  });

  it('keeps the mobile list until a tap and preserves output across resize', async () => {
    window.innerWidth = 390;
    await render();
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('aside button')!.click());
    expect(container.querySelector('textarea')).not.toBeNull();
    const calls = vi.mocked(api.herdrCommand).mock.calls.length;
    await act(async () => {
      window.innerWidth = 1024;
      window.dispatchEvent(new Event('resize'));
    });
    expect(vi.mocked(api.herdrCommand).mock.calls.length).toBe(calls);
    expect(container.querySelector('pre')!.textContent).toBe('latest pane output');
  });

  it('refreshes output every minute while status continues every thirty seconds', async () => {
    vi.useFakeTimers();
    await render();
    const reads = () => vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'read').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(reads()).toBe(1);
    expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'status')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(reads()).toBe(2);
    await toggleSetting('Auto-refresh every minute');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toBe(2);
    await act(async () => button('Refresh output').click());
    expect(reads()).toBe(3);
  });

  it('keeps output and auto-refresh preferences independent for each window', async () => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [listed.agents[0], { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] }
      : { req_id: 'r', output: body.target });
    await render();
    await toggleSetting('Auto-refresh every minute');
    const card = (target: string) => [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent?.includes(target))!;
    await act(async () => card('writer').click());
    await act(async () => button('Herdr settings').click());
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    await act(async () => button('Herdr settings').click());
    vi.mocked(api.herdrCommand).mockClear();
    await act(async () => button('Refresh output').click());
    expect(vi.mocked(api.herdrCommand).mock.calls.map(([, body]) => body)).toEqual([{ op: 'read', target: 'writer', lines: 120, read_source: 'detection' }]);
    await act(async () => card('reviewer').click());
    await act(async () => button('Herdr settings').click());
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await act(async () => button('Herdr settings').click());
    expect(container.querySelector('pre')!.textContent).toBe('reviewer');
    expect(api.herdrCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['codex', 'claude'])('refreshes %s without sending remote scrolling keys', async (kind) => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [{ ...listed.agents[0], kind }] }
      : { req_id: 'r', output: '4 new messages (ctrl+End) ↓' });
    await render();
    vi.mocked(api.herdrCommand).mockClear();
    expect(button('Scroll remote to bottom')).toBeUndefined();
    const output = container.querySelector('pre')!;
    Object.defineProperty(output, 'scrollHeight', { value: 1000 });
    await act(async () => button('Refresh output').click());
    expect(output.scrollTop).toBe(1000);
    expect(vi.mocked(api.herdrCommand).mock.calls.map(([, body]) => body)).toEqual([
      { op: 'read', target: 'reviewer', lines: 120, read_source: 'detection' },
    ]);
  });

  it('keeps status and another window responsive during a prompt wait', async () => {
    vi.useFakeTimers();
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, signal) => {
      if (body.op === 'status') return { ...listed, agents: [listed.agents[0], { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] };
      if (body.op === 'read') return { req_id: 'r', output: body.target };
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    await render(); await typePrompt('wait for me');
    await toggleSetting('Wait for result');
    await act(async () => button('Send').click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent?.includes('writer'))!.click());
    expect(container.querySelector('pre')!.textContent).toBe('writer');
    await act(async () => button('Refresh output').click());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'status')).toHaveLength(2);
    expect(button('Stop waiting')).toBeDefined();
    await act(async () => button('Stop waiting').click());
  });

  it('cancels a slow refresh and ignores its late result', async () => {
    vi.useFakeTimers();
    await render();
    let finish: (value: api.HerdrResponse) => void = () => {};
    vi.mocked(api.herdrCommand).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => button('Refresh output').click());
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).toContain('Taking longer than usual');
    await act(async () => button('Cancel refresh').click());
    expect(button('Refresh output').disabled).toBe(false);
    await act(async () => finish({ req_id: 'late', output: 'obsolete snapshot' }));
    expect(container.querySelector('pre')!.textContent).toBe('latest pane output');
    expect(container.textContent).toContain('Output refresh cancelled');
  });

  it('lists running agents from the backend Herdr server', async () => {
    await render();
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'status' },
      expect.any(AbortSignal),
      20_000,
    );
    expect(container.textContent).toContain('reviewer');
    expect(container.textContent).toContain('Working');
    await act(async () => button('Herdr settings').click());
    expect(container.textContent).toContain('Herdr 1.4.0');
    await act(async () => button('Herdr settings').click());
    // Desktop auto-selects the first agent and loads latest output.
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'read', target: 'reviewer', lines: 120, read_source: 'detection' },
      expect.any(AbortSignal),
      25_000,
    );
    expect(container.textContent).toContain('latest pane output');
  });

  it('opens an agent, shows output, and sends a prompt', async () => {
    await render();
    const card = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('reviewer'));
    expect(card).toBeDefined();
    await act(async () => card!.click());
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'read', target: 'reviewer', lines: 120, read_source: 'detection' },
      expect.any(AbortSignal),
      25_000,
    );
    expect(container.textContent).toContain('latest pane output');

    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'please continue');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    await act(async () => send!.click());
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ op: 'prompt', target: 'reviewer', text: 'please continue' }),
      expect.any(AbortSignal),
      25_000,
    );
  });

  it('sends Esc from a tap target', async () => {
    await render();
    const card = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('reviewer'));
    await act(async () => card!.click());
    const esc = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Esc');
    await act(async () => esc!.click());
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'send_keys', target: 'reviewer', keys: ['esc'] },
      expect.any(AbortSignal),
      15_000,
    );
  });

  it('explains a stopped Herdr server', async () => {
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'herdr_unavailable', retryable: true });
    await render();
    expect(container.textContent).toMatch(/not running/i);
  });

  it('does not call a timeout a stopped server', async () => {
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'request_timeout', retryable: true });
    await render();
    expect(container.textContent).not.toMatch(/not running/i);
    expect(container.textContent).toMatch(/timed out/i);
  });

  it('shows the selected agent output and ignores a late read from the previous one', async () => {
    let releaseStale: (value: api.HerdrResponse) => void = () => {};
    const stale = new Promise<api.HerdrResponse>((resolve) => {
      releaseStale = resolve;
    });
    let reviewerReads = 0;
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
      if (body.op === 'status') {
        return {
          req_id: 'h1',
          status: { installed: true, reachable: true, version: '1.4.0' },
          agents: [
            listed.agents[0],
            {
              target: 'explore',
              name: 'explore',
              kind: 'opencode',
              status: 'idle' as const,
              pane_id: 'w1:p1',
              workspace_id: 'w1',
              tab_id: 'w1:t1',
              focused: true,
            },
          ],
        };
      }
      if (body.op === 'read' && body.target === 'reviewer') {
        reviewerReads += 1;
        if (reviewerReads === 1) return { req_id: 'r1', output: 'reviewer transcript' };
        return stale;
      }
      if (body.op === 'read' && body.target === 'explore') {
        return { req_id: 'r2', output: 'explore transcript' };
      }
      return { req_id: 'x' };
    });

    await render();
    expect(container.textContent).toContain('reviewer transcript');

    const refresh = button('Refresh output');
    await act(async () => refresh.click());
    const explore = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('explore'));
    await act(async () => explore!.click());
    expect(container.textContent).not.toContain('reviewer transcript');
    expect(container.querySelector('pre')!.textContent).toBe('explore transcript');

    await act(async () => {
      releaseStale({ req_id: 'stale', output: 'STALE reviewer transcript' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('explore transcript');
    expect(container.textContent).not.toContain('STALE');
    expect(container.textContent).not.toContain('reviewer transcript');
  });

  it('shows the validation message instead of a search error', async () => {
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
      if (body.op === 'status') return listed;
      if (body.op === 'read') return { req_id: 'r1', output: 'latest pane output' };
      throw { error: 'invalid_request', message: 'unsupported key' };
    });
    await render();
    const esc = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Esc');
    await act(async () => esc!.click());
    expect(container.textContent).toContain('unsupported key');
    expect(container.textContent).not.toContain('Invalid search request');
  });
});

it('invalidates snapshots when a named target is replaced by another pane', async () => {
  let pane = 'w1:p2';
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [{ ...listed.agents[0], pane_id: pane, status: 'idle' },
      { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3', status: 'idle' }] }
    : { req_id: 'r', output: body.target === 'reviewer' ? `output from ${pane}` : 'writer output' });
  await render();
  expect(container.querySelector('pre')!.textContent).toBe('output from w1:p2');
  const card = (target: string) => [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent?.includes(target))!;
  await act(async () => card('writer').click());
  pane = 'w1:p99';
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh agent list"]')!.click());
  await act(async () => card('reviewer').click());
  expect(container.textContent).toContain('w1:p99');
  expect(container.querySelector('pre')!.textContent).not.toContain('output from w1:p2');
  expect(container.querySelector('pre')!.textContent).toBe('output from w1:p99');
});

it('aborts a replaced pane read and rejects its late result while refreshing the new pane', async () => {
  let pane = 'w1:p2';
  let delay = false;
  let staleSignal: AbortSignal | undefined;
  let finish: (value: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, signal) => {
    if (body.op === 'status') return { ...listed, agents: [{ ...listed.agents[0], pane_id: pane, status: 'idle' }] };
    if (delay && pane === 'w1:p2') {
      staleSignal = signal;
      return new Promise((resolve) => { finish = resolve; });
    }
    return { req_id: 'r', output: `output from ${pane}` };
  });
  await render();
  delay = true;
  await act(async () => button('Refresh output').click());
  pane = 'w1:p99';
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh agent list"]')!.click());
  expect(staleSignal?.aborted).toBe(true);
  expect(container.querySelector('pre')!.textContent).toBe('output from w1:p99');
  await act(async () => finish({ req_id: 'stale', output: 'obsolete w1:p2 response' }));
  expect(container.querySelector('pre')!.textContent).toBe('output from w1:p99');
});
