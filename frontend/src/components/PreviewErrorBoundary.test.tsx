import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let failure: Error | null;

function Child() {
  if (failure) throw failure;
  return <p>Preview content</p>;
}
function render(identity = 'first', label?: string) {
  act(() => {
    root.render(<PreviewErrorBoundary key={identity} label={label}><Child /></PreviewErrorBoundary>);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
  failure = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('PreviewErrorBoundary', () => {
  it('leaves healthy content interactive and without a fallback', () => {
    render();
    expect(host.textContent).toBe('Preview content');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('contains a throwing child and shows its message and custom label', () => {
    failure = new Error('Chunk unavailable');
    render('first', 'PDF');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('PDF failed');
    expect(host.textContent).toContain('Chunk unavailable');
    expect(host.textContent).not.toContain('Preview content');
  });

  it('uses fallback copy when the thrown error has no message', () => {
    failure = new Error('');
    render();
    expect(host.textContent).toContain('The preview could not be loaded.');
  });

  it('retries the child and recovers after a transient failure', () => {
    failure = new Error('transient');
    render();
    failure = null;
    act(() => { host.querySelector('button')!.click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe('Preview content');
  });

  it('resets when the parent changes the boundary key for another preview identity', () => {
    failure = new Error('broken first file');
    render();
    failure = null;
    render('second');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe('Preview content');
  });
});
