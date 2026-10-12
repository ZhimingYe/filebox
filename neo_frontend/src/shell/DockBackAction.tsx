/**
 * Dock group header actions:
 * - Preview groups (grid): icon Pop out
 * - Popout groups: icon Dock back
 * - Other chrome groups: nothing (top bar covers focused preview)
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { IconDockBack, IconPopOut } from '@classic/components/icons';
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

export function DockBackAction({ api, containerApi, group }: IDockviewHeaderActionsProps) {
  const [isPopout, setIsPopout] = useState(() => api.location.type === 'popout');
  const showPopout = useMemo(() => groupHasPreview(group), [group]);

  useEffect(() => {
    const sub = api.onDidLocationChange((ev) => {
      setIsPopout(ev.location.type === 'popout');
    });
    return () => sub.dispose();
  }, [api]);

  if (isPopout) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: 0 }}>
        <button
          type="button"
          title="Dock back"
          aria-label="Dock back"
          onClick={() => api.moveTo({ position: 'right' })}
          style={iconBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = c.accentBg;
            e.currentTarget.style.color = c.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = c.textMuted;
          }}
        >
          <IconDockBack style={{ width: 13, height: 13 }} />
        </button>
      </div>
    );
  }

  if (!showPopout) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: 0 }}>
      <button
        type="button"
        title="Pop out"
        aria-label="Pop out"
        onClick={() => {
          void containerApi.addPopoutGroup(group);
        }}
        style={iconBtn}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = c.accentBg;
          e.currentTarget.style.color = c.accent;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = c.textMuted;
        }}
      >
        <IconPopOut style={{ width: 13, height: 13 }} />
      </button>
    </div>
  );
}
