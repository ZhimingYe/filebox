import { useState } from 'react';
import { c, font, radius } from '../theme';
import { useIsMobile } from '../state/useIsMobile';
import { HerdrButton, HerdrPopover } from './HerdrControls';
import { QUICK_KEYS, COMMON_KEYS, PROFILE_KEYS, shortcutProfile, type Profile } from '../lib/herdrShortcuts';

export function HerdrShortcuts({ kind, disabled, onSend, compact = false }: {
  kind?: string | null; disabled: boolean; onSend: (keys: string[]) => void; compact?: boolean;
}) {
  const [profile, setProfile] = useState<Profile>(() => shortcutProfile(kind));
  const [query, setQuery] = useState('');
  const isMobile = useIsMobile();
  const [focusedField, setFocusedField] = useState<'profile' | 'search' | null>(null);
  const focus = (name: 'profile' | 'search') => ({
    onFocus: () => setFocusedField(name),
    onBlur: () => setFocusedField((value) => value === name ? null : value),
  });
  const ring = (name: 'profile' | 'search') => focusedField === name ? { borderColor: c.accent, boxShadow: `0 0 0 3px ${c.accentBg}` } : null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shortcuts = [...PROFILE_KEYS[profile], ...COMMON_KEYS]
    .filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery));
  const field = { width: '100%', height: isMobile ? 32 : 30, boxSizing: 'border-box' as const, borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    outline: 'none', transition: 'border-color 0.12s, box-shadow 0.12s',
    borderRadius: radius.md, background: c.surface, color: c.text, fontFamily: font.sans, fontSize: isMobile ? 13 : 12.5, padding: '0 8px' };
  return <div style={{ display: 'flex', flexShrink: 0, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
    <div role="group" aria-label="Remote input keys" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 11, color: c.textMuted, marginRight: 4 }}>Remote</span>
      {QUICK_KEYS.map((item) => <HerdrButton key={item.label} disabled={disabled} touch={isMobile} size="sm" variant="quiet"
        aria-label={item.label} aria-description={item.description} title={item.description} onClick={() => onSend(item.keys)}
        style={{ minWidth: isMobile ? 32 : 30, padding: '0 8px', background: c.bgMuted, fontSize: 11.5, color: c.textSecondary }}>
        {item.label === 'Up' || item.label === 'Down' ? <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"
          fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d={item.label === 'Up' ? 'M4 7l4-4 4 4M8 3v10' : 'M4 9l4 4 4-4M8 13V3'} />
        </svg> : item.label}
      </HerdrButton>)}
    </div>
    <HerdrPopover label="More shortcuts" icon={false} size="sm" trigger={<>More keys <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m4 10 4-4 4 4" /></svg></>} above touch={isMobile} closeOnAction>
      {!compact && <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Remote keyboard</div>}
      <div style={compact ? { display: 'flex', gap: 6, marginBottom: 6 } : undefined}>
      <select aria-label="Shortcut profile" value={profile} style={{ ...field, ...(compact ? { width: 116, flexShrink: 0 } : null), ...ring('profile') }} {...focus('profile')} onChange={(event) => { setProfile(event.target.value as Profile); setQuery(''); }}>
        <option value="common">Common shortcuts</option><option value="pi">pi</option>
        <option value="claude">Claude Code</option><option value="codex">Codex</option>
      </select>
      {!compact && <p style={{ color: c.textMuted, fontSize: 11, lineHeight: 1.5, margin: '8px 0 10px' }}>
        Controls the remote screen, not your unsent message. Defaults depend on the agent's version and active screen.
      </p>}
      <input type="search" aria-label="Search shortcuts" placeholder={compact ? 'Find a key…' : 'Find a key or action…'} value={query}
        onChange={(event) => setQuery(event.target.value)} style={{ ...field, ...(compact ? { flex: 1, minWidth: 0 } : { marginBottom: 6 }), ...ring('search') }} {...focus('search')} />
      </div>
      {shortcuts.length === 0 && <p style={{ color: c.textSecondary, lineHeight: 1.5 }}>No matching shortcuts. Try another key or action.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shortcuts.map((item) => <HerdrButton key={item.label} variant="quiet" disabled={disabled} touch={isMobile}
          aria-label={`${item.label}: ${item.description}`} onClick={() => onSend(item.keys)}
          style={{ width: '100%', height: 'auto', minHeight: isMobile ? 32 : 30, justifyContent: 'space-between', textAlign: 'left', gap: 12, padding: '5px 6px', whiteSpace: 'normal' }}>
          <span style={{ flex: 1, fontSize: 12, lineHeight: 1.35, fontWeight: 400, color: c.text }}>{item.description}</span>
          <kbd style={{ fontFamily: font.mono, fontSize: 10.5, color: c.textSecondary, whiteSpace: 'nowrap',
            background: c.bgSubtle, border: `1px solid ${c.border}`, borderBottomWidth: 2, borderRadius: radius.sm, padding: '1px 5px' }}>{item.label}</kbd>
        </HerdrButton>)}
      </div>
    </HerdrPopover>
  </div>;
}
