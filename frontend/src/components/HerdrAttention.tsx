import { useState } from 'react';
import type { HerdrAttention as Notice } from '../hooks/useHerdrAttention';
import type { AgentInfo } from '../api/client';
import { c, radius, settingsLayout as layout } from '../theme';
import { HerdrButton } from './HerdrControls';
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
    <aside aria-label="Herdr attention" style={{ ...layout.card, flexShrink: 0, margin: '12px 16px 0',
      display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        paddingLeft: 12, flexShrink: 0, fontSize: 12, color: c.text, background: c.warningBg, borderRadius: radius.md }}>
        <span>Herdr · {unread.length} need attention</span>
        <HerdrButton variant="quiet" touch={isMobile} aria-label="Close Herdr reminders" title="Close these reminders"
          onClick={() => { onAcknowledge(unread.map((n) => n.id)); setExpanded(false); }}
          style={{ minWidth: 44 }}>
          <IconClose />
        </HerdrButton>
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
              <HerdrButton touch={isMobile} onClick={() => {
                onAcknowledge([n.id]); setExpanded(false); onOpen(n);
              }}>View in Herdr</HerdrButton>
              <HerdrButton variant="quiet" touch={isMobile} onClick={() => {
                onAcknowledge([n.id]); setExpanded(false);
              }}>Later</HerdrButton>
            </div>
          </div>
        ))}
      </div>
      {!expanded && unread.length > 1 && <HerdrButton variant="quiet" touch={isMobile}
        onClick={() => setExpanded(true)}>Show all {unread.length}</HerdrButton>}
    </aside>
  );
}
