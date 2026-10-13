import { useState } from 'react';
import type { AgentInfo } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  compact?: boolean;
}

function statusMeta(status: AgentInfo['status']) {
  if (status === 'online') return { color: c.success, label: 'Online' };
  if (status === 'slow') return { color: c.warning, label: 'Slow' };
  return { color: c.textMuted, label: 'Offline' };
}

/** Compact meta: latency · root inventory · pending (status via the green/amber dot). */
function agentMeta(a: AgentInfo): string {
  const roots = a.roots.filter((r) => r.enabled).length;
  const parts: string[] = [];
  if (a.status !== 'online') parts.push(statusMeta(a.status).label);
  if (a.rtt_ms !== null) parts.push(`${a.rtt_ms} ms`);
  parts.push(`${roots} root${roots === 1 ? '' : 's'}`);
  if (a.pending_resource_update) parts.push('pending');
  return parts.join(' · ');
}

export function BackendList({ agents, selectedId, onSelect, collapsed = false, compact = false }: Props) {
  if (agents.length === 0) {
    return (
      <div style={{ ...styles.empty, ...(collapsed ? styles.emptyCollapsed : {}) }}>
        {collapsed ? '—' : 'No agents connected'}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div style={styles.collapsedList}>
        {agents.map((a) => (
          <CollapsedAgentItem
            key={a.id}
            agent={a}
            selected={selectedId === a.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={styles.list} role="listbox" aria-label="Agents">
      {agents.map((a) => (
        <AgentRow
          key={a.id}
          agent={a}
          selected={selectedId === a.id}
          compact={compact}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function AgentRow({
  agent: a,
  selected,
  compact,
  onSelect,
}: {
  agent: AgentInfo;
  selected: boolean;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { color: statusColor, label: statusLabel } = statusMeta(a.status);
  const meta = agentMeta(a);

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(a.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${a.name} · ${statusLabel}${a.rtt_ms !== null ? ` · ${a.rtt_ms}ms` : ''}`}
      style={{
        ...styles.item,
        ...(compact ? styles.itemCompact : null),
        ...(selected ? styles.itemSelected : hovered ? styles.itemHover : null),
      }}
    >
      <span style={{ ...styles.rail, background: selected ? c.accent : 'transparent' }} />
      <span style={{ ...styles.dot, background: statusColor }} aria-hidden />
      <div style={styles.itemBody}>
        <span style={{ ...styles.name, ...(selected ? styles.nameSelected : null) }}>
          {a.name}
        </span>
        {meta && <span style={styles.meta}>{meta}</span>}
      </div>
    </button>
  );
}

function CollapsedAgentItem({
  agent: a,
  selected,
  onSelect,
}: {
  agent: AgentInfo;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { color: statusColor, label: statusLabel } = statusMeta(a.status);
  const initial = (a.name.trim()[0] || '?').toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onSelect(a.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${a.name} · ${statusLabel}${a.rtt_ms !== null ? ` · ${a.rtt_ms}ms` : ''}`}
      style={{
        ...styles.collapsedItem,
        ...(selected ? styles.collapsedItemSelected : hovered ? styles.collapsedItemHover : null),
      }}
    >
      <span style={{ ...styles.collapsedRail, background: selected ? c.accent : 'transparent' }} />
      <div
        style={{
          ...styles.avatar,
          ...(selected ? styles.avatarSelected : null),
        }}
      >
        {initial}
      </div>
      <span style={{ ...styles.avatarDot, background: statusColor }} />
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 1 },
  empty: {
    color: c.textMuted, fontSize: 11.5, padding: '6px 8px',
    fontFamily: font.sans, lineHeight: 1.35,
  },
  emptyCollapsed: {
    padding: '4px 0', textAlign: 'center', color: c.textFaint, fontSize: 10.5,
  },
  item: {
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 6,
    width: '100%', margin: 0,
    padding: '5px 6px 5px 8px',
    borderRadius: radius.sm, cursor: 'pointer',
    border: 'none', background: 'transparent',
    transition: 'background 0.12s', fontFamily: font.sans,
    textAlign: 'left', boxSizing: 'border-box',
    minHeight: 36,
  },
  itemCompact: { minHeight: 34, padding: '4px 6px 4px 8px' },
  itemHover: { background: c.bgMuted },
  itemSelected: { background: c.accentBg },
  rail: {
    position: 'absolute', left: 0, top: 6, bottom: 6, width: 2,
    borderRadius: radius.pill, transition: 'background 0.12s',
  },
  dot: {
    width: 5.5, height: 5.5, borderRadius: '50%', flexShrink: 0,
  },
  itemBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  name: {
    color: c.text, fontSize: 12.5, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    letterSpacing: '-0.01em', lineHeight: 1.25,
  },
  nameSelected: { color: c.accent, fontWeight: 600 },
  meta: {
    fontSize: 10.5, color: c.textMuted, lineHeight: 1.2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // ── Collapsed rail ──
  collapsedList: {
    display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center',
  },
  collapsedItem: {
    position: 'relative', width: 36, height: 30, borderRadius: radius.sm,
    cursor: 'pointer', border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.12s', padding: 0,
  },
  collapsedItemHover: { background: c.bgMuted },
  collapsedItemSelected: { background: c.accentBg },
  collapsedRail: {
    position: 'absolute', left: 0, top: 6, bottom: 6, width: 2,
    borderRadius: radius.pill, transition: 'background 0.12s',
  },
  avatar: {
    width: 24, height: 24, borderRadius: radius.sm,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 600, fontFamily: font.sans,
    letterSpacing: '-0.02em',
    background: c.bgMuted, color: c.textSecondary,
  },
  avatarSelected: {
    background: c.accentBg, color: c.accent,
  },
  avatarDot: {
    position: 'absolute', bottom: 2, right: 2, width: 5.5, height: 5.5,
    borderRadius: '50%', border: `1.5px solid ${c.bgSubtle}`, boxSizing: 'border-box',
  },
};
