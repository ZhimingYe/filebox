import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { c, font, radius, shadow } from '../theme';

/** Shared action hierarchy for Herdr onboarding, toolbars and remote input. */
export function HerdrButton({ children, style, touch, variant = 'secondary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { touch?: boolean; variant?: 'primary' | 'secondary' | 'quiet' }) {
  const [hovered, setHovered] = useState(false);
  return <button {...props} type={props.type ?? 'button'}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      minHeight: touch ? 44 : 32, minWidth: touch ? 44 : undefined, padding: '0 12px', flexShrink: 0,
      borderWidth: 1, borderStyle: 'solid', borderColor: variant === 'secondary' ? c.border : 'transparent', borderRadius: radius.md,
      background: variant === 'primary' ? (hovered && !props.disabled ? c.accentHover : c.accent)
        : hovered && !props.disabled ? c.bgMuted : variant === 'secondary' ? c.surface : 'transparent',
      color: variant === 'primary' ? c.onAccent : c.textSecondary, fontFamily: font.sans, fontSize: 13, fontWeight: 500, lineHeight: 1.4,
      cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.5 : 1,
      ...style,
    }}>{children}</button>;
}

/** Non-modal disclosure: pointer dismissal, Escape, and keyboard focus return. */
export function HerdrPopover({ label, trigger, children, above = false, touch = false, closeOnAction = false }: {
  label: string; trigger: ReactNode; children: ReactNode; above?: boolean; touch?: boolean; closeOnAction?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !above) return;
    const fitAbove = () => {
      const triggerTop = root.current?.getBoundingClientRect().top ?? 0;
      if (!triggerTop || !panel.current) return;
      const viewport = window.visualViewport;
      const availableHeight = triggerTop - Math.max(48, viewport?.offsetTop ?? 0) - 8;
      panel.current.style.maxHeight = `${Math.max(0, Math.min(420, (viewport?.height ?? window.innerHeight) * 0.55, availableHeight))}px`;
    };
    fitAbove();
    window.addEventListener('resize', fitAbove);
    window.addEventListener('scroll', fitAbove, true);
    window.visualViewport?.addEventListener('resize', fitAbove);
    return () => {
      window.removeEventListener('resize', fitAbove);
      window.removeEventListener('scroll', fitAbove, true);
      window.visualViewport?.removeEventListener('resize', fitAbove);
    };
  }, [open, above]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button, input, select')?.focus();
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
    <HerdrButton touch={touch} aria-label={label} title={label} aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>{trigger}</HerdrButton>
    {open && <div id={id} ref={panel} role="dialog" aria-label={label} onClick={(event) => {
      if (closeOnAction && (event.target as Element).closest('button')) {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }} style={{
      position: 'absolute', right: 0, ...(above ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
      zIndex: 20, width: 300, maxWidth: 'calc(100vw - 48px)', maxHeight: 'min(420px, 55dvh)', overflow: 'auto',
      padding: 12, boxSizing: 'border-box', border: `1px solid ${c.border}`,
      borderRadius: radius.lg, background: c.surface, boxShadow: shadow.lg,
      color: c.text, fontFamily: font.sans, fontSize: 12,
    }}>{children}</div>}
  </div>;
}
