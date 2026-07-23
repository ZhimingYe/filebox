import type { CSSProperties, ReactNode } from 'react';
import { fileRawUrl, friendlyMessage, withCsrf } from '../api/client';

interface Props {
  agentId: string;
  root: string;
  path: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
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

/**
 * Download trigger via credentialed fetch + blob URL.
 *
 * Uses the CSRF header path (same as text/image previews) so there is no
 * extra POST /api/access-tokens round-trip before the file bytes start.
 * Rendered as a <button> — a real <a href> would either leak a dead
 * unauthenticated URL or force minting into the address bar.
 */
export function FileDownloadLink({ agentId, root, path, children, style, className }: Props) {
  const onClick = async () => {
    try {
      const res = await fetch(fileRawUrl(agentId, root, path), withCsrf());
      if (!res.ok) {
        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          payload = { error: `HTTP ${res.status}` };
        }
        throw payload;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = path.split('/').filter(Boolean).pop() || 'download';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after the click has been processed.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      // Surface via alert only as a last resort — download is a one-shot action.
      window.alert(friendlyMessage(err));
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...buttonReset, ...style }}
      className={className}
    >
      {children ?? 'Download'}
    </button>
  );
}
