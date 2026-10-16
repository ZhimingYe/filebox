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
  vi.unstubAllGlobals();
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
    const hintId = container.querySelector('textarea')!.getAttribute('aria-describedby')!;
    expect(document.getElementById(hintId)!.textContent).toContain('Waiting for approval');
    await act(async () => button('Down').click());
    expect(api.herdrCommand).toHaveBeenCalledWith(agent.id,
      { op: 'send_keys', target: 'w1:p2', keys: ['down'] }, expect.any(AbortSignal), 15_000);
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
    expect(vi.mocked(api.herdrCommand).mock.calls.map(([, body]) => body)).toEqual([{ op: 'read', target: 'w1:p3', lines: 120, read_source: 'detection' }]);
    await act(async () => card('reviewer').click());
    await act(async () => button('Herdr settings').click());
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await act(async () => button('Herdr settings').click());
    expect(container.querySelector('pre')!.textContent).toBe('w1:p2');
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
      { op: 'read', target: 'w1:p2', lines: 120, read_source: 'detection' },
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
    expect(container.querySelector('pre')!.textContent).toBe('w1:p3');
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
      { op: 'read', target: 'w1:p2', lines: 120, read_source: 'detection' },
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
      { op: 'read', target: 'w1:p2', lines: 120, read_source: 'detection' },
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
      expect.objectContaining({ op: 'prompt', target: 'w1:p2', text: 'please continue' }),
      expect.any(AbortSignal),
      25_000,
    );
  });

  it('drops drafts of replaced panes instead of resurrecting them when an id is reused', async () => {
    let pane = listed.agents[0];
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
      if (body.op === 'status') return { ...listed, agents: [pane] };
      return { req_id: 'read', output: 'screen' };
    });
    await render();
    await typePrompt('old pane draft');
    pane = { ...listed.agents[0], pane_id: 'w1:p9' };
    await act(async () => button('Refresh agent list').click());
    expect(container.querySelector('textarea')!.value).toBe('');
    pane = listed.agents[0];
    await act(async () => button('Refresh agent list').click());
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  it('sends Esc from a tap target', async () => {
    await render();
    const card = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('reviewer'));
    await act(async () => card!.click());
    const esc = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Esc');
    await act(async () => esc!.click());
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'send_keys', target: 'w1:p2', keys: ['esc'] },
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
      if (body.op === 'read' && body.target === 'w1:p2') {
        reviewerReads += 1;
        if (reviewerReads === 1) return { req_id: 'r1', output: 'reviewer transcript' };
        return stale;
      }
      if (body.op === 'read' && body.target === 'w1:p1') {
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

it('stopping a prompt wait in A leaves the selected B output request running', async () => {
  let writerSignal: AbortSignal | undefined;
  let finishWriter: (response: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, signal) => {
    if (body.op === 'status') return { ...listed, agents: [listed.agents[0],
      { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] };
    if (body.op === 'prompt') return new Promise((_resolve, reject) => signal!.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    if (body.target === 'w1:p3') {
      writerSignal = signal;
      return new Promise((resolve) => { finishWriter = resolve; });
    }
    return { req_id: 'r', output: 'reviewer output' };
  });
  await render();
  await typePrompt('long running task');
  await toggleSetting('Wait for result');
  await act(async () => button('Send').click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((b) => b.textContent?.includes('writer'))!.click());
  await act(async () => button('Stop waiting').click());
  expect(writerSignal?.aborted).toBe(false);
  await act(async () => finishWriter({ req_id: 'b', output: 'writer finished loading' }));
  expect(container.querySelector('pre')!.textContent).toBe('writer finished loading');
});

it('a replacement pane does not inherit a draft or a late prompt success from its old name', async () => {
  vi.useFakeTimers();
  let pane = 'w1:p2';
  let finish: (response: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') return { ...listed, agents: [{ ...listed.agents[0], pane_id: pane }] };
    if (body.op === 'prompt') return new Promise((resolve) => { finish = resolve; });
    return { req_id: 'r', output: `output ${pane}` };
  });
  await render(); await typePrompt('instructions intended for the old pane');
  await act(async () => button('Send').click());
  pane = 'w1:p99';
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(container.querySelector('textarea')!.value).toBe('');
  await act(async () => finish({ req_id: 'late-success' }));
  expect(container.textContent).not.toContain('Prompt sent.');
  expect(container.querySelector('pre')!.textContent).toBe('output w1:p99');
});

it('does not retry busy input after the original pane is replaced', async () => {
  vi.useFakeTimers();
  let pane = 'w1:p2';
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') return { ...listed, agents: [{ ...listed.agents[0], pane_id: pane }] };
    if (body.op === 'prompt') throw { error: 'agent_busy' };
    return { req_id: 'r', output: `output ${pane}` };
  });
  await render();
  await typePrompt('only for the original pane');
  await act(async () => button('Send').click());
  pane = 'w1:p99';
  await act(async () => button('Refresh agent list').click());
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  const inputs = vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'prompt');
  expect(inputs).toHaveLength(1);
  expect(inputs[0][1].target).toBe('w1:p2');
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  expect(container.textContent).not.toContain('Prompt sent.');
});

it('preserves an unsent draft through a temporary Herdr outage', async () => {
  let unavailable = false;
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') {
      if (unavailable) throw { error: 'herdr_unavailable' };
      return listed;
    }
    return { req_id: 'r', output: 'latest output' };
  });
  await render();
  await typePrompt('unsent work');
  unavailable = true;
  await act(async () => button('Refresh agent list').click());
  expect(container.textContent).toMatch(/not running/i);
  unavailable = false;
  await act(async () => button('Refresh agent list').click());
  expect(container.querySelector('textarea')!.value).toBe('unsent work');
});

it('invalidates snapshots when a named target is replaced by another pane', async () => {
  let pane = 'w1:p2';
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [{ ...listed.agents[0], pane_id: pane, status: 'idle' },
      { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3', status: 'idle' }] }
    : { req_id: 'r', output: body.target === pane ? `output from ${pane}` : 'writer output' });
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

it('keeps reads and input on the same pane when an agent name is reassigned between list refreshes', async () => {
  let nameOwner = 'w1:p2';
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') return listed;
    if (body.op === 'read') return { req_id: 'r', output: `Screen from ${body.target === 'reviewer' ? nameOwner : body.target}` };
    return { req_id: 'r' };
  });
  await render();
  nameOwner = 'w1:p99';
  await act(async () => button('Refresh output').click());
  expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'status')).toHaveLength(1);
  expect(container.querySelector('pre')!.textContent).toBe('Screen from w1:p2');
  await act(async () => button('Enter').click());
  const inputs = vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'send_keys');
  expect(inputs[0][1].target).toBe('w1:p2');
  expect(container.querySelector('pre')!.textContent).toBe('Screen from w1:p2');
});

it('falls back to the target name when no pane id is available', async () => {
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [{ ...listed.agents[0], pane_id: '' }] }
    : { req_id: 'r', output: body.target });
  await render();
  expect(container.querySelector('pre')!.textContent).toBe('reviewer');
  expect(api.herdrCommand).toHaveBeenCalledWith(agent.id,
    { op: 'read', target: 'reviewer', lines: 120, read_source: 'detection' }, expect.any(AbortSignal), 25_000);
});

it.each(['w1:p2', 'w1:p99'])('resets shortcut defaults when the agent type changes in %s', async (paneId) => {
  let item = listed.agents[0];
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [item] } : { req_id: 'r', output: 'screen' });
  await render();
  await act(async () => button('More shortcuts').click());
  expect(container.querySelector('select')!.value).toBe('codex');
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = 'pi'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Refresh agent list').click());
  expect(container.querySelector('select')!.value).toBe('pi');
  item = { ...item, pane_id: paneId, kind: 'claude' };
  await act(async () => button('Refresh agent list').click());
  await act(async () => button('More shortcuts').click());
  expect(container.querySelector('select')!.value).toBe('claude');
  expect(button('Ctrl+T: Show task checklist')).toBeDefined();
  expect(button('Ctrl+T: Open transcript pager')).toBeUndefined();
});

it('resets a custom shortcut profile when a same-kind pane replaces the old pane', async () => {
  let paneId = 'w1:p2';
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [{ ...listed.agents[0], pane_id: paneId }] } : { req_id: 'r', output: 'screen' });
  await render();
  await act(async () => button('More shortcuts').click());
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = 'pi'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  paneId = 'w1:p99';
  await act(async () => button('Refresh agent list').click());
  await act(async () => button('More shortcuts').click());
  expect(container.querySelector('select')!.value).toBe('codex');
});

it.each(['prompt', 'send_keys', 'prompt_error'])('stops %s during its follow-up read and ignores the late output', async (action) => {
  let reads = 0;
  let signal: AbortSignal | undefined;
  let finish: (value: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, s) => {
    if (body.op === 'status') return listed;
    if (body.op === 'read') {
      if (++reads === 1) return { req_id: 'r', output: 'original screen' };
      signal = s;
      return new Promise((resolve) => { finish = resolve; });
    }
    if (action === 'prompt_error') throw { error: 'herdr_timeout' };
    return { req_id: 'sent' };
  });
  await render();
  await typePrompt('continue');
  await act(async () => button(action === 'send_keys' ? 'Enter' : 'Send').click());
  expect(reads).toBe(2);
  expect(signal!.aborted).toBe(false);
  await act(async () => button('Stop waiting').click());
  expect(signal!.aborted).toBe(true);
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  expect(button('Refresh output')).toBeDefined();
  expect(button('Stop waiting')).toBeUndefined();
  expect(container.textContent).toContain('Already submitted input may still be running');
  expect(container.querySelector('textarea')!.value).toBe(action === 'prompt' ? '' : 'continue');
  await act(async () => finish({ req_id: 'late', output: 'cancelled screen' }));
  expect(container.querySelector('pre')!.textContent).toBe('original screen');
  expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'status')).toHaveLength(1);
});

it.each(['prompt', 'read'])('a cancelled %s cannot finish a newer input operation', async (slowOp) => {
  let prompts = 0;
  let reads = 0;
  let finishOld: (value: api.HerdrResponse) => void = () => {};
  let finishNew: (value: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
    if (body.op === 'status') return listed;
    if (body.op === 'prompt') {
      if (++prompts === 2) return new Promise((resolve) => { finishNew = resolve; });
      if (slowOp === 'prompt') return new Promise((resolve) => { finishOld = resolve; });
      return { req_id: 'sent' };
    }
    if (++reads === 2 && slowOp === 'read') return new Promise((resolve) => { finishOld = resolve; });
    return { req_id: 'r', output: 'current screen' };
  });
  await render(); await typePrompt('old task');
  await act(async () => button('Send').click());
  await act(async () => button('Stop waiting').click());
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  await typePrompt('new task');
  await act(async () => button('Send').click());
  expect(prompts).toBe(2);
  await act(async () => finishOld({ req_id: 'old', output: 'old screen' }));
  expect(container.querySelector('textarea')!.disabled).toBe(true);
  expect(container.querySelector('textarea')!.value).toBe('new task');
  expect(button('Stop waiting')).toBeDefined();
  await act(async () => finishNew({ req_id: 'new' }));
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  expect(container.querySelector('textarea')!.value).toBe('');
  expect(container.querySelector('pre')!.textContent).toBe('current screen');
});

it.each(['prompt', 'send_keys'])('stops %s during its follow-up status check and ignores a late list', async (action) => {
  let checks = 0;
  let signal: AbortSignal | undefined;
  let finish: (value: api.HerdrResponse) => void = () => {};
  const report = vi.fn();
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, s) => {
    if (body.op === 'status') {
      if (++checks === 1) return listed;
      signal = s;
      return new Promise((resolve) => { finish = resolve; });
    }
    return { req_id: 'r', output: 'current screen' };
  });
  await act(async () => root.render(<HerdrView agent={agent} onStatus={report} />));
  await typePrompt('continue');
  await act(async () => button(action === 'prompt' ? 'Send' : 'Enter').click());
  expect(checks).toBe(2);
  await act(async () => button('Stop waiting').click());
  expect(signal!.aborted).toBe(true);
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  await act(async () => finish({ ...listed, agents: [] }));
  expect(report).toHaveBeenCalledTimes(1);
  expect(container.querySelector('textarea')).not.toBeNull();
});

it('stopping an action follow-up read in A does not cancel a new read in B', async () => {
  let reads = 0;
  let writerSignal: AbortSignal | undefined;
  let finishWriter: (value: api.HerdrResponse) => void = () => {};
  let finishReviewer: (value: api.HerdrResponse) => void = () => {};
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body, signal) => {
    if (body.op === 'status') return { ...listed, agents: [listed.agents[0],
      { ...listed.agents[0], target: 'writer', name: 'writer', pane_id: 'w1:p3' }] };
    if (body.op === 'prompt') return { req_id: 'sent' };
    if (body.target === 'w1:p3') {
      writerSignal = signal;
      return new Promise((resolve) => { finishWriter = resolve; });
    }
    if (++reads > 1) return new Promise((resolve) => { finishReviewer = resolve; });
    return { req_id: 'r', output: 'reviewer screen' };
  });
  await render(); await typePrompt('continue');
  await act(async () => button('Send').click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((b) => b.textContent?.includes('writer'))!.click());
  await act(async () => button('Stop waiting').click());
  expect(writerSignal!.aborted).toBe(false);
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  expect(button('Cancel refresh')).toBeDefined();
  await act(async () => finishReviewer({ req_id: 'old', output: 'obsolete reviewer screen' }));
  expect(button('Cancel refresh')).toBeDefined();
  await act(async () => finishWriter({ req_id: 'b', output: 'writer screen' }));
  expect(container.querySelector('pre')!.textContent).toBe('writer screen');
});

function mockMultipleAgents() {
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [listed.agents[0], { ...listed.agents[0], target: 'writer', name: 'writer',
      pane_id: 'w1:p3', kind: 'claude', cwd: '/other/project', status: 'idle' }] }
    : { req_id: 'r', output: `screen from ${body.target}` });
}

async function searchAgents(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function filterAgents(value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Filter agents by status"]')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it.each([' WRITER ', 'CLAUDE', '/other', 'w1:p3'])('searches agent metadata for %s without changing the selected pane or requesting output', async (query) => {
  mockMultipleAgents(); await render();
  vi.mocked(api.herdrCommand).mockClear();
  await searchAgents(query);
  const cards = container.querySelectorAll('aside button[aria-pressed]');
  expect(cards).toHaveLength(1);
  expect(cards[0].textContent).toContain('writer');
  expect(container.querySelector('textarea')!.getAttribute('aria-label')).toBe('Prompt for reviewer');
  expect(container.querySelector('pre')!.textContent).toBe('screen from w1:p2');
  expect(api.herdrCommand).not.toHaveBeenCalled();
});

it('combines search and status filters and clears a no-results state without losing the draft', async () => {
  mockMultipleAgents(); await render(); await typePrompt('keep this draft');
  expect(container.querySelector('aside button[aria-pressed="true"]')!.textContent).toContain('Draft');
  await searchAgents('writer');
  await filterAgents('working');
  expect(container.textContent).toContain('No matching agents');
  expect(container.querySelectorAll('aside button[aria-pressed]')).toHaveLength(0);
  await act(async () => button('Clear filters').click());
  expect(container.querySelectorAll('aside button[aria-pressed]')).toHaveLength(2);
  expect(container.querySelector('textarea')!.value).toBe('keep this draft');
  expect(container.querySelector('aside select')!.textContent).toContain('Working · 1');
  await filterAgents('idle');
  expect(container.querySelector('aside button[aria-pressed]')!.textContent).toContain('writer');
  expect(container.querySelector('aside button[aria-pressed]')!.textContent).not.toContain('Draft');
});

it('supports searching on mobile before selecting a window and keeps filters on return', async () => {
  window.innerWidth = 390;
  mockMultipleAgents(); await render(); await searchAgents('writer');
  expect(container.querySelector('textarea')).toBeNull();
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!;
  expect(search.style.fontSize).toBe('16px');
  expect(search.style.minHeight).toBe('44px');
  await act(async () => container.querySelector<HTMLButtonElement>('aside button[aria-pressed]')!.click());
  expect(container.querySelector('textarea')!.getAttribute('aria-label')).toBe('Prompt for writer');
  await typePrompt('mobile draft');
  await act(async () => button('Back to agent list').click());
  expect(container.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!.value).toBe('writer');
  expect(container.querySelector('aside button[aria-pressed]')!.textContent).toContain('Draft');
});

it('shows snapshot mode and offers an explicit refresh for changed status', async () => {
  vi.useFakeTimers();
  let seq = 1;
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
    ? { ...listed, agents: [{ ...listed.agents[0], completion_seq: seq }] }
    : { req_id: 'r', output: `screen ${seq}` });
  await render();
  expect(container.textContent).toContain('Snapshot ·');
  expect(container.textContent).toContain('Auto · 1m');
  await toggleSetting('Auto-refresh every minute');
  expect(container.textContent).toContain('Manual');
  seq = 2;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(button('Refresh changed output')).toBeDefined();
  const snapshotDetails = container.querySelector('[aria-label="Output snapshot details"]')!;
  expect(snapshotDetails.textContent).toContain('Snapshot ·');
  expect(snapshotDetails.textContent).toContain('Manual');
  expect(snapshotDetails.contains(button('Refresh changed output'))).toBe(true);
  expect(container.querySelector('pre')!.textContent).toBe('screen 1');
  await act(async () => button('Refresh changed output').click());
  expect(container.querySelector('pre')!.textContent).toBe('screen 2');
  expect(button('Refresh changed output')).toBeUndefined();
});

it.each([390, 320])('gives settings checkbox labels 44px touch targets at %spx wide', async (width) => {
  window.innerWidth = width;
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('aside button[aria-pressed]')!.click());
  await act(async () => button('Herdr settings').click());
  const labels = [...container.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')]
    .map((input) => input.closest('label')!);
  expect(labels).toHaveLength(3);
  for (const label of labels) expect(Number.parseInt(label.style.minHeight)).toBeGreaterThanOrEqual(44);
});

it('preserves reading position on automatic refresh and jumps locally without sending any remote command', async () => {
  vi.useFakeTimers();
  let screen = 0;
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status' ? listed
    : { req_id: 'r', output: `output ${++screen}` });
  await render();
  const pre = container.querySelector('pre')!;
  Object.defineProperties(pre, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  await act(async () => { pre.scrollTop = 100; pre.dispatchEvent(new Event('scroll', { bubbles: true })); });
  expect(button('Jump to latest output')).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(pre.textContent).toBe('output 2');
  expect(pre.scrollTop).toBe(100);
  vi.mocked(api.herdrCommand).mockClear();
  await act(async () => button('Jump to latest output').click());
  expect(pre.scrollTop).toBe(1000);
  expect(button('Jump to latest output')).toBeUndefined();
  expect(api.herdrCommand).not.toHaveBeenCalled();
});

it('copies only the selected snapshot and scopes copied feedback to that pane', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  mockMultipleAgents(); await render(); await typePrompt('do not copy this');
  vi.mocked(api.herdrCommand).mockClear();
  await act(async () => button('Copy output').click());
  expect(writeText).toHaveBeenLastCalledWith('screen from w1:p2');
  expect(container.textContent).toContain('Output copied to clipboard.');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((b) => b.textContent?.includes('writer'))!.click());
  expect(container.textContent).not.toContain('Output copied to clipboard.');
  await act(async () => button('Copy output').click());
  expect(writeText).toHaveBeenLastCalledWith('screen from w1:p3');
  expect(vi.mocked(api.herdrCommand).mock.calls.every(([, body]) => body.op === 'read')).toBe(true);
});

it('reports clipboard failures without losing output or the draft and allows retry', async () => {
  vi.stubGlobal('navigator', {});
  await render(); await typePrompt('keep my message');
  vi.mocked(api.herdrCommand).mockClear();
  await act(async () => button('Copy output').click());
  expect(container.textContent).toContain('Could not copy. Select the output text');
  expect(container.querySelector('textarea')!.value).toBe('keep my message');
  expect(container.querySelector('pre')!.textContent).toBe('latest pane output');
  expect(button('Copy output').disabled).toBe(false);
  expect(api.herdrCommand).not.toHaveBeenCalled();
});

it('does not show a late clipboard failure under a different pane', async () => {
  let fail: (reason: Error) => void = () => {};
  vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise((_resolve, reject) => { fail = reject; }) } });
  mockMultipleAgents(); await render();
  await act(async () => button('Copy output').click());
  expect(button('Copy output').disabled).toBe(true);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((b) => b.textContent?.includes('writer'))!.click());
  await act(async () => fail(new Error('denied')));
  expect(container.textContent).not.toContain('Could not copy');
  expect(button('Copy output').disabled).toBe(false);
});

it('does not copy placeholder text when there is no output', async () => {
  vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status' ? listed : { req_id: 'r', output: '' });
  await render();
  expect(button('Copy output').disabled).toBe(true);
});

it('grows and shrinks the composer within desktop and mobile height limits', async () => {
  await render();
  const textarea = container.querySelector('textarea')!;
  Object.defineProperty(textarea, 'scrollHeight', { value: 500, configurable: true });
  await typePrompt('many\nlines\nof\ntext');
  expect(textarea.style.height).toBe('160px');
  await act(async () => { window.innerWidth = 390; window.dispatchEvent(new Event('resize')); });
  expect(textarea.style.height).toBe('120px');
  const inputCard = textarea.parentElement!;
  expect(inputCard.style.overflowY).toBe('auto');
  expect(inputCard.parentElement!.style.flexShrink).toBe('1');
  Object.defineProperty(textarea, 'scrollHeight', { value: 20 });
  await typePrompt('');
  expect(textarea.style.height).toBe('56px');
});

it('keeps Enter and IME composition local and sends only explicit Ctrl+Enter', async () => {
  await render(); await typePrompt('draft');
  vi.mocked(api.herdrCommand).mockClear();
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
  });
  expect(api.herdrCommand).not.toHaveBeenCalled();
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
  expect(vi.mocked(api.herdrCommand).mock.calls.filter(([, body]) => body.op === 'prompt')).toHaveLength(1);
});
