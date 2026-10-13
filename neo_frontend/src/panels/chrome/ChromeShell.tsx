import type { CSSProperties, ReactNode } from 'react';
import { c, font } from '../../theme';

export function ChromeShell({ children }: { children: ReactNode }) {
  return <div style={shell}>{children}</div>;
}

export function ChromeNeedAgent({ label }: { label: string }) {
  return (
    <div style={msg}>
      Select an agent in <strong>Files</strong> to open {label}.
    </div>
  );
}

export function ChromeUnsupported({ text }: { text: string }) {
  return <div style={msg}>{text}</div>;
}

const shell: CSSProperties = {
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  background: c.bg,
  color: c.text,
  fontFamily: font.sans,
  fontSize: 13,
  overflow: 'hidden',
};

const msg: CSSProperties = {
  padding: 16,
  color: c.textMuted,
  lineHeight: 1.5,
};
