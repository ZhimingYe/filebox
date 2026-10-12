/**
 * Dock group header actions:
 * - Grid groups: "Pop out" opens the active panel's group in a same-origin window
 * - Popout groups: "Dock back" returns the group to the main dock grid
 *
 * Keeps Pop out reachable without a neo path/toolbar strip inside PreviewPanel.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { c, font } from '../theme';

const btnStyle: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.surface,
  color: c.text,
  cursor: 'pointer',
};

export function DockBackAction({ api, containerApi, group }: IDockviewHeaderActionsProps) {
  const [isPopout, setIsPopout] = useState(() => api.location.type === 'popout');

  useEffect(() => {
    const sub = api.onDidLocationChange((ev) => {
      setIsPopout(ev.location.type === 'popout');
    });
    return () => sub.dispose();
  }, [api]);

  if (isPopout) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 6px' }}>
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

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 6px' }}>
      <button
        type="button"
        title="Pop this group out to a separate window"
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
