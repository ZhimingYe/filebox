import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { IconRefresh } from './icons';
import { c, font, radius, shadow } from '../theme';

const PAGE_SIZE = 50;

/** Presentation for each audit event kind. Unknown kinds fall back to a
 *  neutral badge rather than erroring. */
const EVENT_META: Record<string, { label: string; color: string; bg: string }> = {
  login_success: { label: 'Signed in', color: c.success, bg: c.successBg },
  login_failed: { label: 'Login failed', color: c.danger, bg: c.dangerBg },
  login_rate_limited: { label: 'Rate limited', color: c.warning, bg: c.warningBg },
  logout: { label: 'Signed out', color: c.textSecondary, bg: c.bgMuted },
};

function eventMeta(event: string) {
  return (
    EVENT_META[event] || { label: event, color: c.textSecondary, bg: c.bgMuted }
  );
}

function formatTime(atMs: number): string {
  if (!atMs) return '—';
  const d = new Date(atMs);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/**
 * Hub-level login audit trail: who signed in/out, failed, or hit the rate
 * limit, from where, with which client. Read-only, newest first, with
 * "load older" paging — the hub keeps a bounded history (≈2000 records).
 */
export function LoginAudit() {
  const [entries, setEntries] = useState<api.LoginAuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadOlderError, setLoadOlderError] = useState<string | null>(null);
  // Generation counter: a refresh supersedes in-flight load-older requests
  // so a slow response can't resurrect entries a newer snapshot dropped.
  const genRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const loadInitial = useCallback(async () => {
    const gen = ++genRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const page = await api.getLoginAudit({ limit: PAGE_SIZE }, controller.signal);
      if (genRef.current !== gen) return;
      setEntries(page.entries);
      setHasMore(page.has_more);
      setError(null);
      setLoadOlderError(null);
    } catch (e) {
      if (genRef.current !== gen) return;
      setError(api.friendlyMessage(e));
    }
  }, []);

  useEffect(() => {
    // Initial page load on mount (the parent remounts this view each time
    // the user navigates to Audit). All setState happens after the first
    // await, so the fetch can never cascade synchronously from the effect.
    // A refresh supersedes this fetch via controllerRef + genRef; the
    // aborted fetch must not report an error over the newer snapshot.
    const controller = new AbortController();
    controllerRef.current = controller;
    (async () => {
      try {
        const page = await api.getLoginAudit({ limit: PAGE_SIZE }, controller.signal);
        setEntries(page.entries);
        setHasMore(page.has_more);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(api.friendlyMessage(e));
      }
    })();
    return () => controller.abort();
  }, []);

  const loadOlder = useCallback(async () => {
    if (!entries || entries.length === 0 || loadingMore) return;
    const before = entries[entries.length - 1].id;
    const gen = genRef.current;
    setLoadingMore(true);
    setLoadOlderError(null);
    try {
      const page = await api.getLoginAudit({ limit: PAGE_SIZE, before });
      if (genRef.current !== gen) return;
      setEntries((prev) => (prev ? [...prev, ...page.entries] : page.entries));
      setHasMore(page.has_more);
    } catch (e) {
      if (genRef.current !== gen) return;
      setLoadOlderError(api.friendlyMessage(e));
    } finally {
      if (genRef.current === gen) setLoadingMore(false);
    }
  }, [entries, loadingMore]);

  const refreshing = entries === null;

  return (
    <div style={styles.page}>
      <header style={styles.pageHeader}>
        <div style={styles.pageHeaderText}>
          <p style={styles.eyebrow}>Hub</p>
          <h2 style={styles.pageTitle}>Login audit</h2>
        </div>
        <button
          type="button"
          onClick={loadInitial}
          disabled={refreshing}
          style={{
            ...styles.refreshBtn,
            ...(refreshing ? styles.refreshBtnDisabled : null),
          }}
          title="Refresh audit records"
          aria-label="Refresh audit records"
        >
          <IconRefresh style={{ width: 14, height: 14 }} />
          <span>Refresh</span>
        </button>
      </header>

      <div style={styles.scroll}>
        <div style={styles.stack}>
          <section style={styles.card} aria-labelledby="audit-table-title">
            <div style={styles.cardHeader}>
              <h3 id="audit-table-title" style={styles.cardTitle}>
                Recent activity
              </h3>
              {entries !== null && (
                <span style={styles.count}>
                  {entries.length}
                  {hasMore ? '+' : ''} records
                </span>
              )}
            </div>

            {error ? (
              // A failed refresh surfaces even when stale records are shown,
              // so the retry state is never silent.
              <div style={styles.bannerError} role="alert">
                <span>{error}</span>
                <button type="button" onClick={loadInitial} style={styles.retryBtn}>
                  Retry
                </button>
              </div>
            ) : null}
            {entries !== null && entries.length === 0 && !error ? (
              <div style={styles.empty}>
                No login records yet. Sign-in attempts and sign-outs will show up here.
              </div>
            ) : entries !== null && entries.length > 0 ? (
              <>
                <div style={styles.tableScroll}>
                  <table style={styles.table} aria-label="Login audit records">
                    <thead>
                      <tr>
                        <th style={{ ...styles.th, width: 168 }}>Time</th>
                        <th style={{ ...styles.th, width: 112 }}>Event</th>
                        <th style={{ ...styles.th, width: 110 }}>User</th>
                        <th style={{ ...styles.th, width: 132 }}>IP address</th>
                        <th style={styles.th}>Client</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => {
                        const meta = eventMeta(entry.event);
                        return (
                          <tr key={entry.id} style={styles.tr}>
                            <td
                              style={styles.tdTime}
                              title={entry.at_ms ? new Date(entry.at_ms).toISOString() : undefined}
                            >
                              {formatTime(entry.at_ms)}
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{
                                  ...styles.badge,
                                  color: meta.color,
                                  background: meta.bg,
                                }}
                              >
                                {meta.label}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <span style={styles.userCell} title={entry.username}>
                                {entry.username || '—'}
                              </span>
                            </td>
                            <td style={{ ...styles.td, ...styles.tdMono }}>{entry.ip || '—'}</td>
                            <td style={styles.td} title={entry.user_agent}>
                              <span style={styles.uaCell}>{entry.user_agent || '—'}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {hasMore && (
                  <div style={styles.footer}>
                    {loadOlderError ? (
                      <span style={styles.footerError} role="alert">
                        {loadOlderError}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={loadOlder}
                      disabled={loadingMore}
                      style={{
                        ...styles.loadMoreBtn,
                        ...(loadingMore ? styles.loadMoreBtnDisabled : null),
                      }}
                    >
                      {loadingMore ? 'Loading…' : 'Load older'}
                    </button>
                  </div>
                )}
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  pageHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '20px 24px 14px',
    flexShrink: 0,
  },
  pageHeaderText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  eyebrow: {
    margin: 0,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: c.textMuted,
    fontFamily: font.sans,
  },
  pageTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 650,
    color: c.text,
    letterSpacing: '-0.01em',
    fontFamily: font.sans,
  },
  refreshBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: radius.sm,
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
    flexShrink: 0,
    height: 30,
    boxSizing: 'border-box',
  },
  refreshBtnDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '0 24px 24px',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    maxWidth: 1080,
  },
  card: {
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.xs,
    overflow: 'hidden',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  cardTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
  },
  count: {
    fontSize: 11.5,
    color: c.textMuted,
    fontFamily: font.sans,
  },
  bannerError: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    margin: 16,
    padding: '10px 12px',
    borderRadius: radius.md,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 12.5,
    fontFamily: font.sans,
  },
  retryBtn: {
    padding: '4px 10px',
    borderRadius: radius.sm,
    border: 'none',
    background: c.danger,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: font.sans,
    flexShrink: 0,
  },
  empty: {
    padding: '28px 16px',
    textAlign: 'center',
    color: c.textMuted,
    fontSize: 12.5,
    fontFamily: font.sans,
  },
  tableScroll: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: font.sans,
    fontSize: 12.5,
    minWidth: 620,
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: c.textMuted,
    borderBottom: `1px solid ${c.borderSubtle}`,
    background: c.bgSubtle,
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  td: {
    padding: '9px 12px',
    color: c.text,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 0,
  },
  tdTime: {
    padding: '9px 12px',
    color: c.textSecondary,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    fontSize: 12,
  },
  tdMono: {
    fontFamily: font.mono,
    fontSize: 12,
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: radius.pill,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.4,
  },
  userCell: {
    display: 'inline-block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  },
  uaCell: {
    display: 'inline-block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: c.textSecondary,
    fontSize: 12,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    padding: '10px 16px',
    borderTop: `1px solid ${c.borderSubtle}`,
  },
  footerError: {
    flex: 1,
    color: c.danger,
    fontSize: 12,
    fontFamily: font.sans,
  },
  loadMoreBtn: {
    padding: '5px 12px',
    borderRadius: radius.sm,
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
    transition: 'background 0.12s, color 0.12s',
    height: 30,
    boxSizing: 'border-box',
  },
  loadMoreBtnDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
};
