/**
 * Dock group header actions:
 * - All grid groups: Pop out (always)
 * - Preview groups: New Preview before Pop out
 * - Popout groups: Dock back only
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { IconDockBack, IconPlusPanel, IconPopOut } from '@classic/components/icons';
import { addEmptyPreviewPanel } from '../preview/openInDock';
import { c } from '../theme';

const PREVIEW_COMPONENT = 'preview';

const iconBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  padding: 0,
  borderRadius: 5,
  border: 'none',
  background: 'transparent',
  color: c.textMuted,
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
  flexShrink: 0,
};

function groupHasPreview(group: IDockviewHeaderActionsProps['group']): boolean {
  try {
    return group.panels.some((p) => p.api.component === PREVIEW_COMPONENT);
  } catch {
    return false;
  }
}

function applyHoverHandlers(el: HTMLButtonElement, enter: boolean) {
  if (enter) {
    el.style.background = c.accentBg;
    el.style.color = c.accent;
  } else {
    el.style.background = 'transparent';
    el.style.color = c.textMuted;
  }
}

export function DockBackAction({ api, containerApi }: IDockviewHeaderActionsProps) {
  const [isPopout, setIsPopout] = useState(() => api.location.type === 'popout');
  const isPreviewGroup = useMemo(() => groupHasPreview(group), [group]);

  useEffect(() => {
    const sub = api.onDidLocationChange((ev) => {
      setIsPopout(ev.location.type === 'popout');
    });
    return () => sub.dispose();
  }, [api]);

  if (isPopout) {
    return (
      <div style={rowStyle}>
        <button
          type="button"
          title="Dock back"
          aria-label="Dock back"
          onClick={() => api.moveTo({ position: 'right' })}
          style={iconBtn}
          onMouseEnter={(e) => applyHoverHandlers(e.currentTarget, true)}
          onMouseLeave={(e) => applyHoverHandlers(e.currentTarget, false)}
        >
          <IconDockBack style={{ width: 13, height: 13 }} />
        </button>
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      {isPreviewGroup ? (
        <button
          type="button"
          title="New Preview"
          aria-label="New Preview"
          onClick={() => {
            addEmptyPreviewPanel(containerApi);
          }}
          style={iconBtn}
          onMouseEnter={(e) => applyHoverHandlers(e.currentTarget, true)}
          onMouseLeave={(e) => applyHoverHandlers(e.currentTarget, false)}
        >
          <IconPlusPanel style={{ width: 13, height: 13 }} />
        </button>
      ) : null}
      <button
        type="button"
        title="Pop out"
        aria-label="Pop out"
        onClick={() => {
          void containerApi.addPopoutGroup(group);
        }}
        style={iconBtn}
        onMouseEnter={(e) => applyHoverHandlers(e.currentTarget, true)}
        onMouseLeave={(e) => applyHoverHandlers(e.currentTarget, false)}
      >
        <IconPopOut style={{ width: 13, height: 13 }} />
      </button>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: '100%',
  padding: 0,
  gap: 2,
};
