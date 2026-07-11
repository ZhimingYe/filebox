import type { AgentInfo } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  compact?: boolean;
}

export function BackendList({ agents, selectedId, onSelect, collapsed = false, compact = false }: Props) {
  if (agents.length === 0) {
    return <div style={styles.empty}>{collapsed ? '' : 'No agents connected'}</div>;
  }

  if (collapsed) {
    return (
      <div style={styles.collapsedList}>
        {agents.map((a) => {
          const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
          const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
          const selected = selectedId === a.id;
          const initial = (a.name.trim()[0] || '?').toUpperCase();
          return (
            <div
              key={a.id}
              onClick={() => onSelect(a.id)}
              title={`${a.name} · ${statusLabel}${a.rtt_ms !== null ? ` · ${a.rtt_ms}ms` : ''}${a.pending_resource_update ? ' · pending' : ''}`}
              style={{
                ...styles.collapsedItem,
                ...(selected ? styles.collapsedItemSelected : {}),
                borderLeftColor: selected ? c.accent : 'transparent',
              }}
            >
              <div style={{ ...styles.avatar, background: `${statusColor}20`, color: statusColor }}>
                {initial}
              </div>
              <span style={{ ...styles.avatarDot, background: statusColor }} />
            </div>
          );
        })}
      </div>
    );
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
              ...(compact ? styles.itemCompact : {}),
              ...(selected ? styles.itemSelected : {}),
              borderLeftColor: selected ? c.accent : 'transparent',
            }}
          >
            <div style={{ ...styles.row, ...(compact ? styles.rowCompact : {}) }}>
              <span style={{ ...styles.dot, background: statusColor }} />
              <span style={{ ...styles.name, ...(compact ? styles.nameCompact : {}) }}>{a.name}</span>
              <span style={{ ...styles.statusLabel, ...(compact ? styles.statusLabelCompact : {}), color: statusColor }}>
                {statusLabel}
              </span>
            </div>
            <div style={{ ...styles.meta, ...(compact ? styles.metaCompact : {}) }}>
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
  itemCompact: { padding: '6px 7px', borderLeftWidth: 2 },
  itemSelected: {
    background: c.bgMuted,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  rowCompact: { gap: 6 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  name: {
    color: c.text, fontSize: 13, fontWeight: 500, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  nameCompact: { fontSize: 12.5 },
  statusLabel: { fontSize: 11, fontWeight: 500 },
  statusLabelCompact: { fontSize: 10.5, flexShrink: 0 },
  meta: { display: 'flex', gap: 8, marginTop: 3, fontSize: 12, color: c.textMuted, paddingLeft: 15 },
  metaCompact: { gap: 6, marginTop: 2, fontSize: 11, paddingLeft: 13 },
  pending: { color: c.warning },
  // ── Collapsed rail ──
  collapsedList: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' },
  collapsedItem: {
    position: 'relative', width: 34, height: 32, borderRadius: radius.md, cursor: 'pointer',
    border: '1px solid transparent', borderLeft: '3px solid transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.15s',
  },
  collapsedItemSelected: {
    background: c.accentBg,
  },
  avatar: {
    width: 24, height: 24, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 600, fontFamily: font.sans,
  },
  avatarDot: {
    position: 'absolute', top: 4, right: 4, width: 7, height: 7,
    borderRadius: '50%', border: `1.5px solid ${c.bgSubtle}`, boxSizing: 'border-box',
  },
};
