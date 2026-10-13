import type { IDockviewPanelProps } from 'dockview-react';
import { LoginAudit } from '@lib/components/LoginAudit';
import { ChromeShell } from './ChromeShell';

/** Hub login audit — no agent required. */
export function AuditPanel(_props: IDockviewPanelProps) {
  return (
    <ChromeShell>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <LoginAudit />
      </div>
    </ChromeShell>
  );
}
