import type { AgentInfo } from '../api/client';
import { RootManager } from './RootManager';
import { c, radius, font } from '../theme';

interface Props {
  agent: AgentInfo;
  onRefresh: () => void;
}

export function AgentSettings({ agent, onRefresh }: Props) {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{agent.name}</h2>
        <div style={styles.meta}>
          <span style={{
            ...styles.badge,
            background: agent.status === 'online' ? c.successBg : agent.status === 'slow' ? c.warningBg : c.bgMuted,
            color: agent.status === 'online' ? c.success : agent.status === 'slow' ? c.warning : c.textMuted,
          }}>
            {agent.status}
          </span>
          <span style={styles.detail}>Rev: {agent.resource_revision}</span>
          {agent.rtt_ms !== null && <span style={styles.detail}>RTT: {agent.rtt_ms}ms</span>}
          {agent.pending_resource_update && <span style={styles.pending}>Pending update</span>}
        </div>
        {agent.last_config_error && (
          <div style={styles.configError}>
            Config error: {agent.last_config_error}
          </div>
        )}
      </div>

      <div style={styles.content}>
        <RootManager agentId={agent.id} roots={agent.roots} onUpdate={onRefresh} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, fontFamily: font.sans },
  // Header is NOT inside the scroll area, so it must never overflow — every
  // flex child below is given minWidth:0 / flexWrap so it wraps or ellipses
  // instead of pushing past the right edge (the cause of "settings cut off"
  // at narrow widths or high browser zoom).
  header: { padding: '16px 24px', borderBottom: `1px solid ${c.border}`, minWidth: 0 },
  title: { margin: 0, color: c.text, fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { display: 'flex', flexWrap: 'wrap', rowGap: 6, columnGap: 14, marginTop: 10, alignItems: 'center' },
  badge: {
    padding: '3px 12px', borderRadius: radius.pill,
    fontSize: 12, fontWeight: 500,
  },
  detail: { color: c.textMuted, fontSize: 12 },
  pending: { color: c.warning, fontSize: 12, fontWeight: 500 },
  configError: {
    color: c.danger, fontSize: 12, marginTop: 12,
    padding: '10px 14px', background: c.dangerBg, borderRadius: radius.md,
    border: `1px solid ${c.danger}20`, overflowWrap: 'break-word',
  },
  content: { flex: 1, overflow: 'auto', padding: '20px 24px', minWidth: 0 },
};
