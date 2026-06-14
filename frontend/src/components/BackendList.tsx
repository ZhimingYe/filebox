import type { AgentInfo } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function BackendList({ agents, selectedId, onSelect }: Props) {
  if (agents.length === 0) {
    return <div style={styles.empty}>No agents connected</div>;
  }

  return (
    <div style={styles.list}>
      {agents.map((a) => {
        const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
        const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
        const selected = selectedId === a.id;
        return (
          <div
            key={a.id}
            onClick={() => onSelect(a.id)}
            style={{
              ...styles.item,
              ...(selected ? styles.itemSelected : {}),
              borderLeftColor: selected ? c.accent : 'transparent',
            }}
          >
            <div style={styles.row}>
              <span style={{ ...styles.dot, background: statusColor }} />
              <span style={styles.name}>{a.name}</span>
              <span style={{ ...styles.statusLabel, color: statusColor }}>{statusLabel}</span>
            </div>
            <div style={styles.meta}>
              {a.rtt_ms !== null && <span>{a.rtt_ms}ms</span>}
              {a.pending_resource_update && <span style={styles.pending}>pending</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  empty: { color: c.textMuted, fontSize: 13, padding: '8px 4px' },
  item: {
    padding: '8px 10px', borderRadius: radius.md, cursor: 'pointer',
    border: '1px solid transparent', borderLeft: '3px solid transparent',
    transition: 'all 0.15s', fontFamily: font.sans,
  },
  itemSelected: {
    background: c.bgMuted,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  name: { color: c.text, fontSize: 13, fontWeight: 500 },
  statusLabel: { fontSize: 11, fontWeight: 500 },
  meta: { display: 'flex', gap: 8, marginTop: 3, fontSize: 12, color: c.textMuted, paddingLeft: 15 },
  pending: { color: c.warning },
};
