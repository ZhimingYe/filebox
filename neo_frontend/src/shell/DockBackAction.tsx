/**
 * Group header action shown only inside a popout window: "Dock back" returns
 * the whole popout group to the main dock grid (dockview group.api.moveTo
 * without a target group creates a new grid group and moves the panels in,
 * closing the popout window).
 */

import { useEffect, useState } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { c, font } from '../theme';

export function DockBackAction({ api }: IDockviewHeaderActionsProps) {
  const [isPopout, setIsPopout] = useState(() => api.location.type === 'popout');

  useEffect(() => {
    const sub = api.onDidLocationChange((ev) => {
      setIsPopout(ev.location.type === 'popout');
    });
    return () => sub.dispose();
  }, [api]);

  if (!isPopout) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 6px' }}>
      <button
        type="button"
        title="Return this group to the main window"
        onClick={() => api.moveTo({ position: 'right' })}
        style={{
          fontFamily: font.sans,
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 6,
          border: `1px solid ${c.border}`,
          background: c.surface,
          color: c.text,
          cursor: 'pointer',
        }}
      >
        Dock back
      </button>
    </div>
  );
}
