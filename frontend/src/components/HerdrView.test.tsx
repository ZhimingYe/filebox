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
});

async function render() {
  await act(async () => root.render(<HerdrView agent={agent} />));
}

describe('HerdrView', () => {
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
