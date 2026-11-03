import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { c, font, radius, shadow } from '../theme';

type HerdrButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  touch?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet';
  /** Square, icon-only control. */
  icon?: boolean;
  size?: 'sm' | 'md';
};

/** Shared action hierarchy for Herdr onboarding, toolbars and remote input. */
export function HerdrButton({ children, style, touch, variant = 'secondary', icon = false, size = 'md', ...props }: HerdrButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const hot = hovered && !props.disabled;
  const height = touch ? 44 : (size === 'sm' ? 26 : 30);
  return <button {...props} type={props.type ?? 'button'}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={(event) => { setKeyboardFocus(event.currentTarget.matches(':focus-visible')); props.onFocus?.(event); }}
    onBlur={(event) => { setKeyboardFocus(false); props.onBlur?.(event); }}
    style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      outline: keyboardFocus ? `2px solid ${c.accent}` : 'none', outlineOffset: 1,
      height, minWidth: icon ? height : undefined, padding: icon ? 0 : size === 'sm' ? '0 8px' : '0 12px',
      flexShrink: 0, boxSizing: 'border-box',
      borderWidth: 1, borderStyle: 'solid', borderRadius: size === 'sm' ? radius.sm : radius.md,
      borderColor: variant === 'secondary' ? (hot ? c.textFaint : c.border) : 'transparent',
      background: variant === 'primary' ? (hot ? c.accentHover : c.accent)
        : hot ? (variant === 'secondary' ? c.bgSubtle : c.bgMuted)
          : variant === 'secondary' ? c.surface : 'transparent',
      boxShadow: variant === 'secondary' ? shadow.xs : 'none',
      color: variant === 'primary' ? c.onAccent : hot ? c.text : c.textSecondary,
      fontFamily: font.sans, fontSize: size === 'sm' ? 12 : 12.5, fontWeight: 500, lineHeight: 1,
      whiteSpace: 'nowrap', cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.45 : 1,
      transition: 'background 0.12s, border-color 0.12s, color 0.12s',
      ...style,
    }}>{children}</button>;
}

/** Inline status line: one visual language for info, warnings and errors. */
export function HerdrCallout({ tone = 'info', children, onDismiss, dismissLabel = 'Dismiss', touch, role, style }: {
  tone?: 'info' | 'warning' | 'danger'; children: ReactNode; onDismiss?: () => void; dismissLabel?: string;
  touch?: boolean; role?: 'status' | 'alert'; style?: CSSProperties;
}) {
  const accent = tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : c.textMuted;
  return <div role={role} style={{
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0,
    minHeight: 30, boxSizing: 'border-box', padding: onDismiss ? '3px 3px 3px 10px' : '6px 10px',
    borderRadius: radius.md, border: `1px solid ${tone === 'info' ? c.border : 'transparent'}`,
    background: tone === 'danger' ? c.dangerBg : tone === 'warning' ? c.warningBg : c.bgSubtle,
    color: tone === 'danger' ? c.danger : c.text, fontFamily: font.sans, fontSize: 12, lineHeight: 1.45,
    ...style,
  }}>
    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: radius.pill, background: accent, flexShrink: 0 }} />
    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    {onDismiss && <HerdrButton variant="quiet" icon size="sm" touch={touch} aria-label={dismissLabel} title={dismissLabel}
      onClick={onDismiss} style={{ color: tone === 'danger' ? c.danger : c.textMuted }}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </HerdrButton>}
  </div>;
}

/** Non-modal disclosure: pointer dismissal, Escape, and keyboard focus return. */
export function HerdrPopover({ label, trigger, children, above = false, touch = false, closeOnAction = false, triggerVariant = 'quiet', icon = true, size = 'md' }: {
  label: string; trigger: ReactNode; children: ReactNode; above?: boolean; touch?: boolean; closeOnAction?: boolean;
  triggerVariant?: 'secondary' | 'quiet'; icon?: boolean; size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const fitPanel = () => {
      const anchor = root.current?.getBoundingClientRect();
      if (!anchor || !panel.current) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const topEdge = Math.max(48, viewportTop + 8);
      const bottomEdge = viewportTop + height - 8;
      const spaceAbove = Math.max(0, anchor.top - topEdge - 8);
      const spaceBelow = Math.max(0, bottomEdge - anchor.bottom - 8);
      const opensAbove = above ? spaceAbove >= 120 || spaceAbove >= spaceBelow
        : spaceBelow < 120 && spaceAbove > spaceBelow;
      const availableHeight = opensAbove ? spaceAbove : spaceBelow;
      panel.current.style.width = `${Math.max(0, Math.min(300, width - 32))}px`;
      panel.current.style.maxHeight = `${Math.max(0, Math.min(420, height * 0.55, availableHeight))}px`;
      const bounds = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(viewportLeft + 16, Math.min(anchor.right - bounds.width, viewportLeft + width - bounds.width - 16))}px`;
      panel.current.style.top = `${opensAbove ? Math.max(topEdge, anchor.top - 8 - bounds.height) : Math.max(topEdge, anchor.bottom + 8)}px`;
    };
    fitPanel();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitPanel);
    if (root.current) observer?.observe(root.current);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener('resize', fitPanel);
    window.addEventListener('scroll', fitPanel, true);
    window.visualViewport?.addEventListener('resize', fitPanel);
    window.visualViewport?.addEventListener('scroll', fitPanel);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fitPanel);
      window.removeEventListener('scroll', fitPanel, true);
      window.visualViewport?.removeEventListener('resize', fitPanel);
      window.visualViewport?.removeEventListener('scroll', fitPanel);
    };
  }, [open, above]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div ref={root} style={{ position: 'relative', flexShrink: 0 }}
    onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }}>
    <HerdrButton touch={touch} variant={triggerVariant} icon={icon} size={size} aria-label={label} title={label} aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}
      style={open ? { background: c.bgMuted, color: c.text } : undefined}>{trigger}</HerdrButton>
    {open && <div id={id} ref={panel} role="dialog" aria-label={label} tabIndex={-1} onClick={(event) => {
      if (closeOnAction && (event.target as Element).closest('button')) {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }} style={{
      position: 'fixed',
      zIndex: 20, width: 300, maxHeight: 'min(420px, 55dvh)', overflow: 'auto',
      padding: 14, boxSizing: 'border-box', border: `1px solid ${c.border}`,
      borderRadius: radius.lg, background: c.surface, boxShadow: shadow.lg, outline: 'none',
      color: c.text, fontFamily: font.sans, fontSize: 12,
    }}>{children}</div>}
  </div>;
}
