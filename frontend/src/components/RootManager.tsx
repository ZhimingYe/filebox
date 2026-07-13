import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font, shadow } from '../theme';

interface Props {
  agentId: string;
  roots: { name: string; path_display: string; enabled: boolean }[];
  onUpdate: () => void;
}

/**
 * Client-side heuristic for roots that almost certainly expose an entire home
 * directory or a very shallow filesystem tree.
 *
 * The agent expands `~` / `~/…` against *its* `$HOME` (not the browser's).
 * We cannot know that HOME here, so:
 *  - bare `~` / `~/` → treated as "entire home"
 *  - absolute `/home/<user>` and `/Users/<user>` → typical home layouts
 *  - absolute depth ≤ 1 (`/`, `/data`) → too shallow
 *
 * Returns a human-readable reason, or null when no extra confirm is needed.
 * Pure / side-effect free so it stays easy to reason about in the UI gate.
 */
export function broadRootExposureReason(path: string): string | null {
  const raw = path.trim();
  if (!raw) return null;

  // Normalize separators; agent also accepts `~\…`.
  const p = raw.replace(/\\/g, '/');

  // ── Tilde forms (agent expands against its HOME) ─────────────────────────
  if (p === '~' || p === '~/') {
    return "This path expands to the agent user's entire home directory on the remote machine.";
  }
  if (p.startsWith('~/')) {
    const rest = p.slice(2).replace(/\/+$/, '');
    if (rest === '' || rest === '.') {
      return "This path expands to the agent user's entire home directory on the remote machine.";
    }
    // ~/.. or ~/../.. — not a real home subdir; will resolve very broadly.
    const segs = rest.split('/').filter(Boolean);
    if (segs.length > 0 && segs.every((s) => s === '.' || s === '..')) {
      return 'This path walks up from the home directory and may expose a large portion of the remote filesystem.';
    }
  }

  // ── Absolute paths ───────────────────────────────────────────────────────
  if (p.startsWith('/')) {
    const normalized = p.replace(/\/+$/, '') || '/';
    if (normalized === '/') {
      return 'Mounting the filesystem root exposes the entire remote machine.';
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 1) {
      return `Mounting '/${parts[0]}' is very broad and may expose system or multi-user data.`;
    }
    // Typical user-home layouts: /home/<user>, /Users/<user>
    if (parts.length === 2 && (parts[0] === 'home' || parts[0] === 'Users')) {
      return `This looks like a user home directory (/${parts.join('/')}). Mounting it exposes that user's full home tree.`;
    }
  }

  return null;
}

/** Compact switch control — commercial settings pattern (no native checkbox). */
function ToggleSwitch({
  on,
  disabled,
  onToggle,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      title={on ? 'Disable root' : 'Enable root'}
      style={{
        ...styles.switchTrack,
        ...(on ? styles.switchTrackOn : null),
        ...(disabled ? styles.switchDisabled : null),
      }}
    >
      <span
        style={{
          ...styles.switchThumb,
          ...(on ? styles.switchThumbOn : null),
        }}
      />
    </button>
  );
}

export function RootManager({ agentId, roots, onUpdate }: Props) {
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-row in-flight ops. A Set so concurrent toggles on different roots
  // don't clobber each other's busy flag in `finally`.
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(() => new Set());
  // Non-null while waiting for the user to confirm a broad/shallow root path.
  // Confirmation is *only* via the warning card (not a second primary-button mode).
  const [confirmReason, setConfirmReason] = useState<string | null>(null);
  // Two-step delete: name of root awaiting confirmation.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const markBusy = (name: string) => {
    setBusyNames((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  };
  const clearBusy = (name: string) => {
    setBusyNames((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  // Defensive reset if this component is ever reused across agents without unmount.
  useEffect(() => {
    setNewName('');
    setNewPath('');
    setError(null);
    setLoading(false);
    setBusyNames(new Set());
    setConfirmReason(null);
    setPendingDelete(null);
  }, [agentId]);

  // Esc dismisses the broad-path gate (and clear delete confirm when focused page-wide).
  useEffect(() => {
    if (!confirmReason && !pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setConfirmReason(null);
      setPendingDelete(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmReason, pendingDelete]);

  const doAdd = async () => {
    if (!newName.trim() || !newPath.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      await api.addRoot(agentId, newName.trim(), newPath.trim());
      setNewName('');
      setNewPath('');
      setConfirmReason(null);
      onUpdate();
    } catch (e: unknown) {
      setError(friendlyMessage(e));
      // Keep confirmReason so a rejected add (e.g. path missing) can be retried
      // without re-reading the warning, but path edits still clear it.
    } finally {
      setLoading(false);
    }
  };

  /**
   * Primary "Add root" only submits immediately for *narrow* paths.
   * Broad paths open the warning region; the user must click "Add anyway"
   * there (single confirmation surface — no dual Confirm-add button).
   */
  const handleAddClick = () => {
    if (!newName.trim() || !newPath.trim() || loading) return;
    setError(null);
    setPendingDelete(null);

    const reason = broadRootExposureReason(newPath);
    if (reason) {
      setConfirmReason(reason);
      return;
    }
    setConfirmReason(null);
    void doAdd();
  };

  const handleNameChange = (value: string) => {
    setNewName(value);
    setConfirmReason(null);
  };

  const handlePathChange = (value: string) => {
    setNewPath(value);
    setConfirmReason(null);
  };

  const handleToggle = async (name: string, currentlyEnabled: boolean) => {
    // Only block double-submit on this row; freeze the desired value at click time.
    if (busyNames.has(name)) return;
    const nextEnabled = !currentlyEnabled;
    setPendingDelete(null);
    markBusy(name);
    setError(null);
    try {
      await api.patchRoot(agentId, name, { enabled: nextEnabled });
      onUpdate();
    } catch (e: unknown) {
      setError(friendlyMessage(e));
    } finally {
      clearBusy(name);
    }
  };

  const handleDelete = async (name: string) => {
    if (busyNames.has(name)) return;
    markBusy(name);
    setError(null);
    try {
      await api.deleteRoot(agentId, name);
      setPendingDelete(null);
      onUpdate();
    } catch (e: unknown) {
      setError(friendlyMessage(e));
    } finally {
      clearBusy(name);
    }
  };

  const canSubmit = !!newName.trim() && !!newPath.trim() && !loading;
  // While a broad-path warning is open, the primary button is inert (user acts
  // in the card). Keeps a single confirmation path.
  const primaryDisabled = !canSubmit || confirmReason !== null;

  return (
    <div style={styles.root}>
      {error && (
        <div style={styles.errorBox} role="alert">
          <span style={styles.errorTitle}>Could not update roots</span>
          <p style={styles.errorBody}>{error}</p>
          <button
            type="button"
            style={styles.errorDismiss}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Existing roots ──────────────────────────────────────────────── */}
      {roots.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No workspace roots yet</p>
          <p style={styles.emptyBody}>
            Add a named directory below. Only paths inside these roots can be
            browsed — keep them as specific as practical.
          </p>
        </div>
      ) : (
        <ul style={styles.list} aria-label="Configured roots">
          {roots.map((r) => {
            const isBusy = busyNames.has(r.name);
            const confirmingDelete = pendingDelete === r.name;
            return (
              <li
                key={r.name}
                style={{
                  ...styles.item,
                  ...(isMobile ? styles.itemMobile : null),
                  ...(!r.enabled ? styles.itemDisabled : null),
                  ...(confirmingDelete ? styles.itemDanger : null),
                }}
              >
                <div style={styles.itemMain}>
                  <div style={styles.itemIdentity}>
                    <span style={styles.rootName}>{r.name}</span>
                    {!r.enabled && (
                      <span style={styles.disabledTag}>Disabled</span>
                    )}
                  </div>
                  <span style={styles.rootPath} title={r.path_display}>
                    {r.path_display}
                  </span>
                </div>

                {confirmingDelete ? (
                  <div
                    style={isMobile ? styles.confirmRowMobile : styles.confirmRow}
                    role="region"
                    aria-label={`Confirm remove ${r.name}`}
                  >
                    <span style={styles.confirmLabel}>Remove this root?</span>
                    <div style={styles.confirmActions}>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setPendingDelete(null)}
                        style={{
                          ...styles.btnGhost,
                          ...(isBusy ? styles.btnDisabled : null),
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDelete(r.name)}
                        style={{
                          ...styles.btnDanger,
                          ...(isBusy ? styles.btnDisabled : null),
                        }}
                      >
                        {isBusy ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={isMobile ? styles.itemActionsMobile : styles.itemActions}>
                    <div style={styles.toggleGroup}>
                      <ToggleSwitch
                        on={r.enabled}
                        disabled={isBusy}
                        onToggle={() => void handleToggle(r.name, r.enabled)}
                        label={r.enabled ? `Disable ${r.name}` : `Enable ${r.name}`}
                      />
                      <span style={styles.toggleCaption}>
                        {isBusy ? 'Saving…' : r.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setConfirmReason(null);
                        setPendingDelete(r.name);
                      }}
                      style={{
                        ...styles.btnRemove,
                        ...(isBusy ? styles.btnDisabled : null),
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Add form ────────────────────────────────────────────────────── */}
      <div style={styles.addSection}>
        <div style={styles.addSectionHeader}>
          <h4 style={styles.addSectionTitle}>Add root</h4>
          <p style={styles.addSectionHint}>
            Name is a short label shown in the browser. Path is on the agent
            host — use <span style={styles.code}>~/…</span> for home-relative
            paths or an absolute path.
          </p>
        </div>

        <div style={isMobile ? styles.addFormMobile : styles.addForm}>
          <label style={isMobile ? styles.fieldMobile : styles.field}>
            <span style={styles.fieldLabel}>Name</span>
            <input
              value={newName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. projects"
              autoComplete="off"
              spellCheck={false}
              style={styles.input}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // Enter on a broad path opens the warning; does not skip it.
                  handleAddClick();
                }
              }}
            />
          </label>
          <label
            style={
              isMobile
                ? styles.fieldMobile
                : { ...styles.field, ...styles.fieldGrow }
            }
          >
            <span style={styles.fieldLabel}>Path on agent</span>
            <input
              value={newPath}
              onChange={(e) => handlePathChange(e.target.value)}
              placeholder="~/work/data or /abs/path"
              autoComplete="off"
              spellCheck={false}
              style={{ ...styles.input, fontFamily: font.mono, fontSize: 12.5 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddClick();
                }
              }}
            />
          </label>
          <div style={isMobile ? styles.addBtnWrapMobile : styles.addBtnWrap}>
            <button
              type="button"
              onClick={handleAddClick}
              disabled={primaryDisabled}
              style={{
                ...styles.btnPrimary,
                ...(primaryDisabled ? styles.btnDisabled : null),
                ...(isMobile ? styles.btnPrimaryFull : null),
              }}
            >
              {loading ? 'Adding…' : 'Add root'}
            </button>
          </div>
        </div>

        {confirmReason && (
          <div
            style={styles.warnBox}
            role="region"
            aria-labelledby="root-broad-warn-title"
          >
            <p id="root-broad-warn-title" style={styles.warnTitle}>
              Broad root path
            </p>
            <p style={styles.warnBody}>{confirmReason}</p>
            <p style={styles.warnBody}>
              Read-only access can still leak secrets that are not on the
              denylist. Prefer a deeper subdirectory (for example{' '}
              <span style={styles.code}>~/project</span> rather than{' '}
              <span style={styles.code}>~</span>).
            </p>
            <div style={isMobile ? styles.warnActionsMobile : styles.warnActions}>
              <button
                type="button"
                onClick={() => setConfirmReason(null)}
                disabled={loading}
                style={{
                  ...styles.btnGhost,
                  ...(loading ? styles.btnDisabled : null),
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doAdd()}
                disabled={!canSubmit}
                style={{
                  ...styles.btnWarn,
                  ...(!canSubmit ? styles.btnDisabled : null),
                }}
              >
                {loading ? 'Adding…' : 'Add anyway'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minWidth: 0,
    // Content-sized; never absorb free height from the settings card (that
    // was stretching the mobile add form and ballooning field gaps).
    flex: '0 0 auto',
  },

  errorBox: {
    position: 'relative',
    padding: '12px 40px 12px 14px',
    background: c.dangerBg,
    border: `1px solid ${c.danger}25`,
    borderRadius: radius.md,
  },
  errorTitle: {
    display: 'block',
    fontSize: 12.5,
    fontWeight: 600,
    color: c.danger,
    marginBottom: 3,
  },
  errorBody: {
    margin: 0,
    color: c.danger,
    fontSize: 12.5,
    lineHeight: 1.4,
    overflowWrap: 'break-word',
  },
  errorDismiss: {
    position: 'absolute',
    top: 8,
    right: 8,
    border: 'none',
    background: 'transparent',
    color: c.danger,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    padding: '4px 6px',
    borderRadius: radius.sm,
    fontFamily: font.sans,
  },

  empty: {
    padding: '28px 16px',
    textAlign: 'center',
    borderRadius: radius.md,
    border: `1px dashed ${c.border}`,
    background: c.bgSubtle,
  },
  emptyTitle: {
    margin: 0,
    fontSize: 13.5,
    fontWeight: 600,
    color: c.text,
  },
  emptyBody: {
    margin: '6px auto 0',
    maxWidth: 360,
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textMuted,
  },

  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 14,
    padding: '12px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    minWidth: 0,
    transition: 'border-color 0.12s, background 0.12s',
  },
  itemMobile: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 12,
  },
  itemDisabled: {
    background: c.bgSubtle,
  },
  itemDanger: {
    borderColor: `${c.danger}40`,
    background: c.dangerBg,
  },
  itemMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    flex: 1,
    minWidth: 0,
  },
  itemIdentity: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  rootName: {
    color: c.text,
    fontSize: 13.5,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  disabledTag: {
    flexShrink: 0,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
    color: c.textMuted,
    background: c.bgMuted,
    padding: '2px 6px',
    borderRadius: radius.sm,
  },
  rootPath: {
    color: c.textMuted,
    fontSize: 12,
    fontFamily: font.mono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  itemActionsMobile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  toggleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  toggleCaption: {
    fontSize: 12,
    fontWeight: 500,
    color: c.textSecondary,
    minWidth: 56,
  },
  switchTrack: {
    position: 'relative',
    width: 36,
    height: 20,
    borderRadius: radius.pill,
    border: 'none',
    padding: 0,
    background: c.bgMuted,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 0.15s',
    boxShadow: `inset 0 0 0 1px ${c.border}`,
  },
  switchTrackOn: {
    background: c.accent,
    boxShadow: 'none',
  },
  switchDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
  switchThumb: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 16,
    height: 16,
    borderRadius: radius.pill,
    background: c.surface,
    boxShadow: shadow.control,
    transition: 'transform 0.15s',
  },
  switchThumbOn: {
    transform: 'translateX(16px)',
  },

  confirmRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  confirmRowMobile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  confirmLabel: {
    fontSize: 12.5,
    fontWeight: 500,
    color: c.danger,
  },
  confirmActions: {
    display: 'flex',
    gap: 8,
  },

  addSection: {
    paddingTop: 4,
    borderTop: `1px solid ${c.borderSubtle}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    flex: '0 0 auto',
  },
  addSectionHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  addSectionTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
  },
  addSectionHint: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textMuted,
  },
  addForm: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    flexWrap: 'wrap',
  },
  // Column stack: do NOT use flex-grow on children — that absorbs free height
  // from the settings card and leaves a huge empty band between Name and Path
  // (the mobile gap reported in screenshots).
  addFormMobile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 12,
    flex: '0 0 auto',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    minWidth: 0,
    flex: '1 1 120px',
  },
  // Mobile: content-sized height only (no flex-grow).
  fieldMobile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    minWidth: 0,
    flex: '0 0 auto',
    width: '100%',
  },
  fieldGrow: {
    flex: '2 1 200px',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: c.textMuted,
    letterSpacing: '0.02em',
    textTransform: 'uppercase' as const,
  },
  input: {
    padding: '9px 12px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.text,
    fontSize: 13,
    outline: 'none',
    fontFamily: font.sans,
    width: '100%',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  addBtnWrap: {
    flexShrink: 0,
    paddingBottom: 0,
  },
  addBtnWrapMobile: {
    width: '100%',
    flex: '0 0 auto',
    marginTop: 4,
  },

  btnPrimary: {
    padding: '9px 18px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: font.sans,
    height: 36,
    transition: 'background 0.15s, opacity 0.15s',
    whiteSpace: 'nowrap',
  },
  btnPrimaryFull: {
    width: '100%',
  },
  btnWarn: {
    padding: '7px 14px',
    borderRadius: radius.md,
    border: 'none',
    background: c.warning,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  btnGhost: {
    padding: '7px 14px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  btnDanger: {
    padding: '7px 14px',
    borderRadius: radius.md,
    border: 'none',
    background: c.danger,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  btnRemove: {
    padding: '6px 12px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    transition: 'color 0.12s, border-color 0.12s, background 0.12s, opacity 0.12s',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'default',
  },

  warnBox: {
    padding: '12px 14px',
    background: c.warningBg,
    border: `1px solid ${c.warning}40`,
    borderRadius: radius.md,
  },
  warnTitle: {
    margin: '0 0 6px',
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
  },
  warnBody: {
    margin: '0 0 8px',
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textSecondary,
    fontFamily: font.sans,
  },
  code: {
    fontFamily: font.mono,
    fontSize: 12,
    color: c.text,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: radius.sm,
  },
  warnActions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  warnActionsMobile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 4,
  },
};
