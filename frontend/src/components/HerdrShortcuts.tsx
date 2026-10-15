import { useState } from 'react';
import { c, font, radius } from '../theme';

import { QUICK_KEYS, COMMON_KEYS, PROFILE_KEYS, shortcutProfile, type Profile } from '../lib/herdrShortcuts';

export function HerdrShortcuts({ kind, disabled, onSend }: {
  kind?: string | null; disabled: boolean; onSend: (keys: string[]) => void;
}) {
  const [profile, setProfile] = useState<Profile>(() => shortcutProfile(kind));
  const [choice, setChoice] = useState('');
  const shortcuts = [...PROFILE_KEYS[profile], ...COMMON_KEYS];
  const selected = shortcuts.find((item) => item.label === choice);
  return <div>
    <div style={row}>
      {QUICK_KEYS.map((item) => <button key={item.label} type="button" disabled={disabled}
        title={item.description} style={control} onClick={() => onSend(item.keys)}>{item.label}</button>)}
    </div>
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', color: c.textSecondary, fontSize: 12 }}>More shortcuts</summary>
      <div style={{ ...row, marginTop: 8 }}>
        <select aria-label="Shortcut profile" value={profile} style={control}
          onChange={(e) => { setProfile(e.target.value as Profile); setChoice(''); }}>
          <option value="common">Common</option><option value="pi">pi</option>
          <option value="claude">Claude Code CLI</option><option value="codex">Codex CLI</option>
        </select>
        <select aria-label="Remote shortcut" value={choice} style={{ ...control, flex: 1, minWidth: 0, maxWidth: '100%' }}
          onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a shortcut</option>
          {shortcuts.map((item) => <option key={item.label} value={item.label}>{item.label} — {item.description}</option>)}
        </select>
        <button type="button" style={control} disabled={disabled || !selected}
          onClick={() => { if (selected) onSend(selected.keys); }}>Send shortcut</button>
      </div>
      <p style={{ color: c.textMuted, fontSize: 12, lineHeight: 1.5, margin: '8px 0 0' }}>
        {selected ? `${selected.label}: ${selected.description}. ` : ''}
        Keys go to the remote window, not the draft below. Defaults vary with version, screen and custom keybindings.
        Home/End/PageUp/PageDown/Delete need a Herdr build with navigation-key support; v0.9.5 lacks it.
      </p>
    </details>
  </div>;
}
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' };
const control: React.CSSProperties = {
  fontFamily: font.sans, fontSize: 12, minHeight: 44, padding: '6px 10px',
  border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.surface, color: c.text,
  cursor: 'pointer',
};
