/**
 * Dock group header actions:
 * - Preview groups (grid): "Pop out" opens that group in a same-origin window
 * - Popout groups: "Dock back" returns the group to the main dock grid
 * - Other chrome groups (Files / Search / …): no per-group Pop out (top bar covers focused preview)
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { c, font } from '../theme';

const PREVIEW_COMPONENT = 'preview';

const btnStyle: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 11,
  padding: '1px 8px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.surface,
  color: c.text,
  cursor: 'pointer',
  lineHeight: '18px',
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
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 4px' }}>
        <button
          type="button"
          title="Return this group to the main window"
          onClick={() => api.moveTo({ position: 'right' })}
          style={btnStyle}
        >
          Dock back
        </button>
      </div>
    );
  }

  if (!showPopout) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 4px' }}>
      <button
        type="button"
        title="Pop this preview group out to a separate window"
        onClick={() => {
          void containerApi.addPopoutGroup(group);
        }}
        style={btnStyle}
      >
        Pop out
      </button>
    </div>
  );
}
