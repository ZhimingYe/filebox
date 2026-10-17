import { useState } from 'react';
import { c, font, radius } from '../theme';
import { useIsMobile } from '../state/useIsMobile';
import { HerdrButton, HerdrPopover } from './HerdrControls';
import { QUICK_KEYS, COMMON_KEYS, PROFILE_KEYS, shortcutProfile, type Profile } from '../lib/herdrShortcuts';

export function HerdrShortcuts({ kind, disabled, onSend }: {
  kind?: string | null; disabled: boolean; onSend: (keys: string[]) => void;
}) {
  const [profile, setProfile] = useState<Profile>(() => shortcutProfile(kind));
  const [query, setQuery] = useState('');
  const isMobile = useIsMobile();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shortcuts = [...PROFILE_KEYS[profile], ...COMMON_KEYS]
    .filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery));
  return <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
    <div role="group" aria-label="Remote input keys" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {QUICK_KEYS.map((item) => <HerdrButton key={item.label} disabled={disabled} touch={isMobile}
        aria-label={item.label} aria-description={item.description} title={item.description} onClick={() => onSend(item.keys)}>
        {item.label === 'Up' || item.label === 'Down' ? <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"
          fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d={item.label === 'Up' ? 'M4 7l4-4 4 4M8 3v10' : 'M4 9l4 4 4-4M8 13V3'} />
        </svg> : item.label}
      </HerdrButton>)}
    </div>
    <HerdrPopover label="More shortcuts" trigger={<>Keys <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 10 4-4 4 4" /></svg></>} above touch={isMobile} closeOnAction>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Remote keyboard</div>
      <select aria-label="Shortcut profile" value={profile} style={{
        width: '100%', minHeight: isMobile ? 44 : 32, border: `1px solid ${c.border}`,
        borderRadius: radius.sm, background: c.surface, color: c.text, fontFamily: font.sans, fontSize: isMobile ? 16 : 12, padding: '0 8px',
      }} onChange={(event) => { setProfile(event.target.value as Profile); setQuery(''); }}>
        <option value="common">Common shortcuts</option><option value="pi">pi</option>
        <option value="claude">Claude Code</option><option value="codex">Codex</option>
      </select>
      <p style={{ color: c.textSecondary, fontSize: 11, lineHeight: 1.5, margin: '8px 0' }}>
        Controls the remote screen, not your unsent message. Defaults depend on the agent's version and active screen.
      </p>
      <input type="search" aria-label="Search shortcuts" placeholder="Find a key or action…" value={query}
        onChange={(event) => setQuery(event.target.value)} style={{
          width: '100%', minHeight: isMobile ? 44 : 32, boxSizing: 'border-box', marginBottom: 6,
          border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.surface,
          color: c.text, fontFamily: font.sans, fontSize: isMobile ? 16 : 12, padding: '0 8px',
        }} />
      {shortcuts.length === 0 && <p style={{ color: c.textSecondary, lineHeight: 1.5 }}>No matching shortcuts. Try another key or action.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shortcuts.map((item) => <HerdrButton key={item.label} disabled={disabled} touch={isMobile}
          aria-label={`${item.label}: ${item.description}`} onClick={() => onSend(item.keys)}
          style={{ width: '100%', justifyContent: 'space-between', textAlign: 'left', gap: 12, padding: '7px 6px' }}>
          <span style={{ flex: 1, fontSize: 12 }}>{item.description}</span>
          <kbd style={{ fontFamily: font.sans, fontSize: 11, color: c.textSecondary, whiteSpace: 'nowrap',
            background: c.bgSubtle, border: `1px solid ${c.border}`, borderRadius: radius.sm, padding: '2px 5px' }}>{item.label}</kbd>
        </HerdrButton>)}
      </div>
    </HerdrPopover>
  </div>;
}
