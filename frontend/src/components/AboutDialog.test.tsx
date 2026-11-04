import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = {
  project: { name: 'filebox', license: 'Apache-2.0', files: [] },
  packages: [
    {
      name: 'react', version: '19.0.0', license: 'MIT', repository: 'https://example.com/react',
      components: ['frontend'], files: [{ name: 'LICENSE', text: 'react-license' }],
    },
    {
      name: 'zod', version: '4.0.0', license: 'Apache-2.0', repository: 'git://github.com/example/zod',
      components: ['hub', 'agent'], files: [],
    },
  ],
  texts: { 'react-license': 'Full React license text.' },
};

let AboutDialog: typeof import('./AboutDialog').AboutDialog;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  ({ AboutDialog } = await import('./AboutDialog'));
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => fixture,
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(open = true) {
  await act(async () => {
    root.render(<AboutDialog open={open} health={null} agents={[]} isLikelyDev={false} onClose={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text) || candidate.getAttribute('aria-label') === text)!;
}

async function openLicenses() {
  await act(async () => {
    button('Open source licenses').click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function search(query: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter licenses"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function rows() {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-expanded]')].map((row) => row.textContent ?? '');
}

describe('AboutDialog licenses', () => {
  it('opens the license view and fetches the manifest once', async () => {
    await render();
    await openLicenses();
    expect(container.textContent).toContain('Open source licenses');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/third-party-licenses.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders the project and third-party package rows', async () => {
    await render();
    await openLicenses();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain('filebox');
    expect(rows().some((row) => row.includes('react') && row.includes('19.0.0'))).toBe(true);
    expect(rows().some((row) => row.includes('zod') && row.includes('4.0.0'))).toBe(true);
  });

  it('filters by package name and license and reports empty results', async () => {
    await render();
    await openLicenses();
    await search('react');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('react');
    await search('Apache');
    expect(rows()).toHaveLength(2);
    expect(rows().some((row) => row.includes('react'))).toBe(false);
    await search('no-such-package');
    expect(container.textContent).toContain('No matching packages.');
  });

  it('shows the full license text when a package row is expanded', async () => {
    await render();
    await openLicenses();
    await act(async () => button('react').click());
    expect(container.textContent).toContain('Full React license text.');
  });

  it('does not render a repository link for a non-http URL', async () => {
    await render();
    await openLicenses();
    await act(async () => button('zod').click());
    expect(container.querySelector('a[href="git://github.com/example/zod"]')).toBeNull();
    expect(container.textContent).not.toContain('Repository');
  });

  it('shows a retryable error and refetches after Retry', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => fixture });
    await render();
    await openLicenses();
    expect(container.textContent).toContain('Could not load the license list.');
    await act(async () => {
      button('Retry').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows().some((row) => row.includes('react'))).toBe(true);
  });

  it('times out an unresponsive fetch and retries', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockImplementationOnce((_url: RequestInfo | URL, options?: RequestInit) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      )
      .mockResolvedValueOnce({ ok: true, json: async () => fixture });
    await render();
    await openLicenses();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.textContent).toContain('Could not load the license list.');

    await act(async () => {
      button('Retry').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows().some((row) => row.includes('react'))).toBe(true);
  });

  it('returns to the main About view with Back', async () => {
    await render();
    await openLicenses();
    await act(async () => button('Back').click());
    expect(container.textContent).toContain('Homepage');
    expect(container.querySelector('input[aria-label="Filter licenses"]')).toBeNull();
  });
});
