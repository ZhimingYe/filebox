import { useState } from 'react';
import type { HerdrAttention as Notice } from '../hooks/useHerdrAttention';
import type { AgentInfo } from '../api/client';
import { c, radius } from '../theme';
import { IconClose } from './icons';

export function HerdrAttention({ notices, agents, onAcknowledge, onOpen, isMobile }: {
  notices: Notice[];
  agents: AgentInfo[];
  onAcknowledge: (ids: number[]) => void;
  onOpen: (notice: Notice) => void;
  isMobile: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const unread = notices.filter((n) => !n.acknowledged);
  if (!unread.length) return null;
  const shown = expanded ? unread : unread.slice(0, 1);
  return (
    <aside aria-label="Herdr attention" style={{ flexShrink: 0, minWidth: 0, margin: '6px 12px',
      display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch',
      border: `1px solid ${c.border}`, borderRadius: radius.lg, background: c.surface }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        paddingLeft: 12, flexShrink: 0, fontSize: 12, color: c.text, background: c.warningBg, borderRadius: radius.md }}>
        <span>Herdr · {unread.length} need attention</span>
        <button type="button" aria-label="Close Herdr reminders" title="Close these reminders"
          onClick={() => { onAcknowledge(unread.map((n) => n.id)); setExpanded(false); }}
          style={{ ...button, display: 'grid', placeItems: 'center', minWidth: 44, background: 'transparent', border: 0 }}>
          <IconClose />
        </button>
      </div>
      <div style={{ flex: 1, minWidth: 0, maxHeight: isMobile ? '25vh' : '30vh', overflowY: 'auto' }}>
        {shown.map((n) => (
          <div key={n.id} style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 12, color: c.textSecondary, overflowWrap: 'anywhere' }}>
                {agents.find((a) => a.id === n.backendId)?.name ?? n.backendId} · {n.name}
              </div>
              <p role="status" style={{ fontSize: 13, lineHeight: 1.5, margin: '4px 0', color: c.text }}>{n.message}</p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={button} onClick={() => {
                onAcknowledge([n.id]); setExpanded(false); onOpen(n);
              }}>View in Herdr</button>
              <button type="button" style={button} onClick={() => {
                onAcknowledge([n.id]); setExpanded(false);
              }}>Later</button>
            </div>
          </div>
        ))}
      </div>
      {!expanded && unread.length > 1 && <button type="button" style={button}
        onClick={() => setExpanded(true)}>Show all {unread.length}</button>}
    </aside>
  );
}

const button: React.CSSProperties = { minHeight: 44, padding: '6px 12px', cursor: 'pointer',
  border: `1px solid ${c.border}`, borderRadius: radius.md, color: c.text, background: c.bgSubtle, fontSize: 12 };
