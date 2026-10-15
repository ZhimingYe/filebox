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

async function typePrompt(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
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

  it('uses completion_seq to refresh a turn completed between idle polls', async () => {
    vi.useFakeTimers();
    let seq = 1;
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => body.op === 'status'
      ? { ...listed, agents: [{ ...listed.agents[0], status: 'idle', completion_seq: seq }] }
      : { req_id: 'r', output: `answer ${seq}` });
    await render();
    seq = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
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
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
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
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
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

  it.each([false, true])('refreshes a short turn after sending (retry final read: %s)', async (failFinalRead) => {
    vi.useFakeTimers();
    let listCalls = 0;
    let readCalls = 0;
    vi.mocked(api.herdrCommand).mockImplementation(async (_id, body) => {
      if (body.op === 'status') {
        listCalls += 1;
        return {
          ...listed,
          agents: [{ ...listed.agents[0], status: listCalls === 2 ? 'working' : 'idle' }],
        };
      }
      if (body.op === 'read') {
        readCalls += 1;
        if (readCalls === 3 && failFinalRead) throw { error: 'herdr_timeout' };
        return {
          req_id: 'r',
          output: readCalls === 1 ? 'old answer' : readCalls === 2 ? 'partial answer' : 'completed answer',
        };
      }
      return { req_id: 'p' };
    });
    await render();
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'quick task');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send')!;
    await act(async () => send.click());
    expect(container.textContent).toContain('partial answer');
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(listCalls).toBe(3);
    if (failFinalRead) {
      expect(container.textContent).toContain('partial answer');
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    }
    expect(container.textContent).toContain('completed answer');
    const completedReads = readCalls;
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(readCalls).toBe(completedReads);
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
    expect(container.textContent).toContain('Herdr 1.4.0');
    // Desktop auto-selects the first agent and loads latest output.
    expect(api.herdrCommand).toHaveBeenCalledWith(
      agent.id,
      { op: 'read', target: 'reviewer', lines: 120 },
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
      { op: 'read', target: 'reviewer', lines: 120 },
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

    const refresh = container.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement;
    await act(async () => refresh.click());
    const explore = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('explore'));
    await act(async () => explore!.click());
    expect(container.textContent).not.toContain('reviewer transcript');

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
