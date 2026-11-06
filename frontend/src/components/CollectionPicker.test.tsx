import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../api/client';
import { CollectionPicker } from './CollectionPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CollectionPicker', () => {
  let host: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    anchor = document.createElement('button');
    document.body.append(host, anchor);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    anchor.remove();
  });

  it('stays open when its own list scrolls after the hover-only trigger unmounts', () => {
    const onClose = vi.fn();
    const agent = { id: 'a1', collections: [] } as unknown as AgentInfo;
    act(() => {
      root.render(
        <CollectionPicker
          agent={agent}
          target={{ root: 'r', path: '/f.txt' }}
          anchorEl={anchor}
          onClose={onClose}
          onChanged={() => {}}
        />,
      );
    });
    const panel = host.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();

    anchor.remove();
    act(() => {
      (panel!.lastElementChild ?? panel!).dispatchEvent(new Event('scroll'));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
