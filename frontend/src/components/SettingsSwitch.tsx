import type { ButtonHTMLAttributes } from 'react';
import { c, radius, shadow } from '../theme';

export function SettingsSwitch({ checked, style, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { checked: boolean }) {
  return <button {...props} type="button" role="switch" aria-checked={checked} disabled={disabled}
    style={{ position: 'relative', width: 40, height: 22, borderRadius: radius.pill,
      border: `1px solid ${checked ? c.accent : c.border}`, background: checked ? c.accent : c.bgMuted,
      cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0, padding: 0,
      transition: 'background 0.15s, border-color 0.15s', opacity: disabled ? 0.5 : 1, ...style }}>
    <span aria-hidden="true" style={{ position: 'absolute', top: 2, left: 2, width: 16, height: 16,
      borderRadius: radius.pill, background: c.surface, boxShadow: shadow.xs,
      transition: 'transform 0.15s', transform: checked ? 'translateX(18px)' : undefined }} />
  </button>;
}
