import type { CSSProperties, ReactNode } from 'react';
import { fileRawAccessUrl, friendlyMessage } from '../api/client';

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
 * Download trigger that mints a short-lived `access_token` on click so the
 * CSRF synchronizer never appears in the address bar / history / logs.
 *
 * Rendered as a <button>, not an <a>: there is no valid href to fall back to
 * (the token only exists after minting), so a real anchor would offer
 * "open in new tab" / "copy link address" affordances that silently 403.
 */
export function FileDownloadLink({ agentId, root, path, children, style, className }: Props) {
  const onClick = async () => {
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
