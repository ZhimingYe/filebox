import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { fileRawAccessUrl, friendlyMessage } from '../api/client';

/** Cooldown after a click so rapid double-clicks can't fire two downloads. */
const COOLDOWN_MS = 3000;

interface Props {
  agentId: string;
  root: string;
  path: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  title?: string;
  'aria-label'?: string;
}

// Undoes UA <button> chrome (border/background/padding/font) so callers'
// link-styled `style` objects (originally written for <a>) still render
// identically. Anything the caller sets explicitly overrides these.
const buttonReset: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  fontFamily: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
};

// While cooling down the button is non-interactive; dim it and drop the
// pointer cursor so the state reads visually. Caller `style` still wins.
const buttonDisabled: CSSProperties = {
  cursor: 'default',
  opacity: 0.55,
};

/**
 * Download trigger that mints a short-lived `access_token` on click so the
 * CSRF synchronizer never appears in the address bar / history / logs.
 *
 * Rendered as a <button>, not an <a>: there is no valid href to fall back to
 * (the token only exists after minting), so a real anchor would offer
 * "open in new tab" / "copy link address" affordances that silently 403.
 *
 * After a click the button disables itself for COOLDOWN_MS so a fast double
 * click can't queue a second download; no per-call state is kept beyond
 * that. The timer is cleared on unmount.
 */
export function FileDownloadLink({
  agentId, root, path, children, style, className, title, 'aria-label': ariaLabel,
}: Props) {
  const [coolingDown, setCoolingDown] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Inline action rows (Explorer tree rows, preview headers inside other
    // clickable containers) must not trigger the surrounding row's own
    // click handler.
    event.stopPropagation();
    if (coolingDown) return;
    setCoolingDown(true);
    timerRef.current = window.setTimeout(() => setCoolingDown(false), COOLDOWN_MS);
    void (async () => {
      try {
        const url = await fileRawAccessUrl(agentId, root, path);
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        // Surface via alert only as a last resort — download is a one-shot action.
        window.alert(friendlyMessage(err));
      }
    })();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={coolingDown}
      style={{ ...buttonReset, ...(coolingDown ? buttonDisabled : null), ...style }}
      className={className}
      title={title}
      aria-label={ariaLabel}
    >
      {children ?? 'Download'}
    </button>
  );
}
