import { useState } from 'react';
import type { AiAgentAttention as Notice } from '../hooks/useAiAgentAttention';
import type { AgentInfo } from '../api/client';
import { c, font, radius, settingsLayout as layout } from '../theme';
import { AiAgentButton } from './AiAgentControls';
import { IconClose } from './icons';

export function AiAgentAttention({ notices, agents, onAcknowledge, onOpen, isMobile }: {
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
  const closeButton = <AiAgentButton variant="quiet" icon size="sm" touch={isMobile} aria-label="Close AI Agents reminders" title="Close these reminders"
    onClick={() => { onAcknowledge(unread.map((n) => n.id)); setExpanded(false); }} style={{ color: c.textMuted }}>
    <IconClose style={{ width: 13, height: 13 }} />
  </AiAgentButton>;
  return (
    <aside aria-label="AI Agents attention" style={{ ...layout.card, flexShrink: 0, margin: isMobile ? '8px 12px' : '12px 20px',
      fontFamily: font.sans }}>
      <div style={{ maxHeight: isMobile ? '25vh' : '30vh', overflowY: 'auto' }}>
        {shown.map((n, index) => {
          const dot = <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: radius.pill, background: c.warning, flexShrink: 0,
            boxShadow: `0 0 0 3px ${c.warningBg}`, marginTop: isMobile ? 6 : 0 }} />;
          const text = <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: c.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ color: c.text, fontWeight: 600 }}>{n.name}</span>
              {' · '}{agents.find((a) => a.id === n.backendId)?.name ?? n.backendId}
              {index === 0 && unread.length > 1 && ` · ${unread.length} need attention`}
            </div>
            <p role="status" style={{ fontSize: 12.5, lineHeight: 1.45, margin: '2px 0 0', color: c.textSecondary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap' }} title={n.message}>{n.message}</p>
          </div>;
          const actions = <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <AiAgentButton variant="quiet" size="sm" touch={isMobile} style={{ color: c.accent }} onClick={() => {
              onAcknowledge([n.id]); setExpanded(false); onOpen(n);
            }}>View in AI Agents</AiAgentButton>
            <AiAgentButton variant="quiet" size="sm" touch={isMobile} onClick={() => {
              onAcknowledge([n.id]); setExpanded(false);
            }}>Later</AiAgentButton>
            {index === 0 && !expanded && unread.length > 1 && <AiAgentButton variant="quiet" size="sm" touch={isMobile}
              onClick={() => setExpanded(true)}>Show all {unread.length}</AiAgentButton>}
          </div>;
          const divider = index ? `1px solid ${c.borderSubtle}` : undefined;
          return isMobile
            ? <div key={n.id} style={{ padding: '8px 4px 4px 12px', borderTop: divider }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>{dot}{text}{index === 0 ? closeButton : <span style={{ width: 28, flexShrink: 0 }} />}</div>
              <div style={{ marginLeft: 8, marginTop: 2 }}>{actions}</div>
            </div>
            : <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 8px 8px 14px', borderTop: divider }}>
              {dot}{text}{actions}
              {index === 0 ? <><span aria-hidden="true" style={{ width: 1, height: 16, background: c.border, flexShrink: 0 }} />{closeButton}</>
                : <span style={{ width: 39, flexShrink: 0 }} />}
            </div>;
        })}
      </div>
    </aside>
  );
}
