import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { fileRawAccessUrl, fileRawUrl, friendlyMessage } from '../api/client';

interface Props {
  agentId: string;
  root: string;
  path: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/**
 * Download link that mints a short-lived `access_token` on click so the CSRF
 * synchronizer never appears in the address bar / history / logs.
 */
export function FileDownloadLink({ agentId, root, path, children, style, className }: Props) {
  const onClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
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
    <a
      href={fileRawUrl(agentId, root, path)}
      download
      onClick={onClick}
      style={style}
      className={className}
    >
      {children ?? 'Download'}
    </a>
  );
}
