import { useState, type ReactNode } from 'react';
import { c, font, radius } from '../theme';

/** Match the compact controls used by the Files toolbar at every breakpoint. */
export function TerminalAction({ label, children, pressed, disabled, onClick, showLabel = false }: {
  label: string;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  showLabel?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed}
    disabled={disabled} onClick={onClick}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      height: 28, minWidth: 28, padding: 0,
      border: 'none', borderRadius: radius.md, background: 'transparent',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
      color: pressed ? c.accent : c.textSecondary, fontFamily: font.sans, fontSize: 12, fontWeight: 500 }}>
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      gap: 6, height: 28, minWidth: 28, padding: showLabel ? '0 9px' : 0, boxSizing: 'border-box',
      borderRadius: radius.sm, border: `1px solid ${pressed ? c.accent : c.border}`,
      background: pressed ? c.accentBg : hovered && !disabled ? c.bgMuted : c.surface }}>
      {children}{showLabel && label}
    </span>
  </button>;
}
