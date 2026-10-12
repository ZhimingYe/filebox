/**
 * Progress + new-version toasts — classic App chrome reused as a neo overlay.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSse } from '@classic/state/events';
import { c, font, shadow } from '../theme';
import { formatBytes } from './formatBytes';
import { getDismissedVersion, setDismissedVersion } from './versionToast';

interface ProgressEvent {
  req_id: string;
  phase: string;
  processed: number;
  total: number | null;
  message: string | null;
}

interface Props {
  /** Hub version from useHealth — drives new-version toast. */
  hubVersion?: string | null;
  selectedAgentId?: string | null;
  onHealthRefresh: () => void;
  onTempUpdated?: () => void;
}

export function ChromeToasts({
  hubVersion,
  selectedAgentId,
  onHealthRefresh,
  onTempUpdated,
}: Props) {
  const [progressMap, setProgressMap] = useState<Map<string, ProgressEvent>>(new Map());
  const progressTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const initialVersionRef = useRef<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    const v = hubVersion;
    if (!v) return;
    if (initialVersionRef.current === null) {
      initialVersionRef.current = v;
      if (getDismissedVersion() === v) setNewVersion(null);
      return;
    }
    if (v !== initialVersionRef.current && v !== getDismissedVersion()) {
      setNewVersion(v);
    }
  }, [hubVersion]);

  useSse(useCallback((evt) => {
    if (
      evt.event === 'agent_connected'
      || evt.event === 'agent_disconnected'
      || evt.event === 'resources_updated'
      || evt.event === 'collections_updated'
      || evt.event === 'sync_required'
    ) {
      onHealthRefresh();
    }
    if (evt.event === 'temp_updated') {
      const d = evt.data as { agent_id?: string };
      if (d?.agent_id && d.agent_id === selectedAgentId) {
        onTempUpdated?.();
      }
    }
    if (evt.event === 'progress') {
      const d = evt.data as unknown as ProgressEvent;
      if (d.phase === 'search') return;
      if (d.req_id.startsWith('office_convert_')) return;
      setProgressMap((prev) => {
        const next = new Map(prev);
        next.set(d.req_id, d);
        return next;
      });
      const timers = progressTimers.current;
      if (timers.has(d.req_id)) clearTimeout(timers.get(d.req_id)!);
      timers.set(d.req_id, setTimeout(() => {
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(d.req_id);
          return next;
        });
        timers.delete(d.req_id);
      }, 5000));
    }
  }, [onHealthRefresh, onTempUpdated, selectedAgentId]));

  const activeProgress = Array.from(progressMap.values());

  return (
    <>
      {activeProgress.length > 0 && (
        <div style={progressToast}>
          {activeProgress.map((p) => (
            <div key={p.req_id} style={progressItem}>
              <span style={progressPhase}>{p.phase}</span>
              {p.message ? <span style={progressMsg}>{p.message}</span> : null}
              {p.total !== null ? (
                <span style={progressBytes}>
                  {formatBytes(p.processed)} / {formatBytes(p.total)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {newVersion ? (
        <div style={versionToast}>
          <div style={versionToastText}>
            New version available (v{newVersion}). Reload to update.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={versionReload}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              style={versionDismiss}
              onClick={() => {
                setDismissedVersion(newVersion);
                setNewVersion(null);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

const progressToast: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 50,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 360,
};

const progressItem: CSSProperties = {
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: 8,
  boxShadow: shadow.md,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: font.sans,
  fontSize: 12,
};

const progressPhase: CSSProperties = { fontWeight: 600, color: c.text, textTransform: 'capitalize' };
const progressMsg: CSSProperties = { color: c.textSecondary };
const progressBytes: CSSProperties = { color: c.textMuted, fontFamily: font.mono, fontSize: 11 };

const versionToast: CSSProperties = {
  position: 'fixed',
  left: 16,
  bottom: 16,
  zIndex: 50,
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: 8,
  boxShadow: shadow.md,
  padding: 12,
  maxWidth: 320,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  fontFamily: font.sans,
};

const versionToastText: CSSProperties = { color: c.text, fontSize: 13, lineHeight: 1.4 };
const versionReload: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: 'none',
  background: c.accent,
  color: '#fff',
  cursor: 'pointer',
};
const versionDismiss: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.bgMuted,
  color: c.textSecondary,
  cursor: 'pointer',
};
