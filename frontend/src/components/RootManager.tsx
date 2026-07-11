import { useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font } from '../theme';

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

export function RootManager({ agentId, roots, onUpdate }: Props) {
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Non-null while waiting for the user to confirm a broad/shallow root path.
  // Cleared whenever name/path edits, cancel, or a successful add.
  const [confirmReason, setConfirmReason] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const doAdd = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await api.addRoot(agentId, newName.trim(), newPath.trim());
      setNewName('');
      setNewPath('');
      setConfirmReason(null);
      onUpdate();
    } catch (e: any) {
      setError(friendlyMessage(e));
      // Keep confirmReason so a rejected add (e.g. path missing) can be retried
      // without re-reading the warning, but path edits still clear it.
    } finally {
      setLoading(false);
    }
  };

  const handleAddClick = () => {
    if (!newName.trim() || !newPath.trim() || loading) return;
    setError(null);

    // First click on a broad path only surfaces the warning; second click
    // (Confirm add) proceeds. Narrow paths skip the gate entirely.
    const reason = broadRootExposureReason(newPath);
    if (reason && confirmReason === null) {
      setConfirmReason(reason);
      return;
    }
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

  const handleToggle = async (name: string, current: boolean) => {
    try {
      await api.patchRoot(agentId, name, { enabled: !current });
      onUpdate();
    } catch (e: any) {
      setError(friendlyMessage(e));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await api.deleteRoot(agentId, name);
      onUpdate();
    } catch (e: any) {
      setError(friendlyMessage(e));
    }
  };

  const awaitingConfirm = confirmReason !== null;

  return (
    <div>
      {error && (
        <div style={styles.errorBox}>
          <p style={styles.error}>{error}</p>
        </div>
      )}

      {/* Add form */}
      <div style={isMobile ? styles.addRowMobile : styles.addRow}>
        <input
          value={newName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="Name"
          style={isMobile ? styles.inputMobile : styles.input}
        />
        <input
          value={newPath}
          onChange={(e) => handlePathChange(e.target.value)}
          placeholder="~/path/to/directory or /abs/path"
          style={isMobile ? styles.inputMobile : { ...styles.input, flex: 2 }}
        />
        <button
          onClick={handleAddClick}
          disabled={loading || !newName.trim() || !newPath.trim()}
          style={
            isMobile
              ? {
                  ...styles.addBtnMobile,
                  ...(awaitingConfirm ? styles.addBtnConfirm : {}),
                }
              : {
                  ...styles.addBtn,
                  ...(awaitingConfirm ? styles.addBtnConfirm : {}),
                }
          }
        >
          {loading ? 'Adding…' : awaitingConfirm ? 'Confirm add' : 'Add'}
        </button>
      </div>

      {confirmReason && (
        <div style={styles.warnBox} role="alertdialog" aria-labelledby="root-broad-warn-title">
          <p id="root-broad-warn-title" style={styles.warnTitle}>
            Broad root path
          </p>
          <p style={styles.warnBody}>{confirmReason}</p>
          <p style={styles.warnBody}>
            Read-only access can still leak secrets that are not on the denylist.
            Prefer a deeper subdirectory (for example <span style={styles.warnCode}>~/project</span>
            {' '}rather than <span style={styles.warnCode}>~</span>).
          </p>
          <div style={isMobile ? styles.warnActionsMobile : styles.warnActions}>
            <button
              type="button"
              onClick={() => setConfirmReason(null)}
              disabled={loading}
              style={styles.warnCancelBtn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doAdd()}
              disabled={loading || !newName.trim() || !newPath.trim()}
              style={styles.warnConfirmBtn}
            >
              {loading ? 'Adding…' : 'Add anyway'}
            </button>
          </div>
        </div>
      )}

      {/* Root list */}
      {roots.length === 0 ? (
        <div style={styles.empty}>No roots configured. Add one above.</div>
      ) : (
        <div style={styles.list}>
          {roots.map((r) => (
            <div key={r.name} style={isMobile ? styles.itemMobile : styles.item}>
              <div style={styles.itemInfo}>
                <span style={styles.rootName}>{r.name}</span>
                <span style={styles.rootPath}>{r.path_display}</span>
              </div>
              <div style={isMobile ? styles.actionsMobile : styles.actions}>
                <button
                  onClick={() => handleToggle(r.name, r.enabled)}
                  style={{
                    ...styles.actionBtn,
                    color: r.enabled ? c.success : c.textFaint,
                    background: r.enabled ? c.successBg : 'transparent',
                  }}
                >
                  {r.enabled ? 'enabled' : 'disabled'}
                </button>
                <button onClick={() => handleDelete(r.name)} style={{ ...styles.actionBtn, color: c.danger }}>
                  remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  errorBox: {
    padding: '10px 14px', background: c.dangerBg, border: `1px solid ${c.danger}20`,
    borderRadius: radius.md, marginBottom: 16,
  },
  error: { color: c.danger, fontSize: 13, margin: 0 },
  addRow: { display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  addRowMobile: {
    display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12,
  },
  input: {
    padding: '9px 14px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 13, flex: 1, minWidth: 0, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  // Same as `input` but without `flex` — in the column mobile layout, `flex: 1`
  // would affect vertical growth (meaningless without a fixed-height container)
  // and width is already full via the default `align-items: stretch`.
  inputMobile: {
    padding: '9px 14px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 13, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  addBtn: {
    padding: '9px 22px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 500, flexShrink: 0, transition: 'background 0.15s',
  },
  addBtnMobile: {
    padding: '9px 22px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 500, width: '100%', transition: 'background 0.15s',
  },
  // Confirm step: same shape as Add, warning-colored so the second click is obvious.
  addBtnConfirm: {
    background: c.warning,
    color: '#fff',
  },
  warnBox: {
    padding: '12px 14px',
    background: c.warningBg,
    border: `1px solid ${c.warning}40`,
    borderRadius: radius.md,
    marginBottom: 20,
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
  warnCode: {
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
  warnCancelBtn: {
    padding: '7px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  warnConfirmBtn: {
    padding: '7px 14px',
    borderRadius: radius.md,
    border: 'none',
    background: c.warning,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  empty: { color: c.textMuted, fontSize: 13, padding: '24px 0' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  item: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, padding: '12px 16px', borderRadius: radius.lg, border: `1px solid ${c.border}`,
    background: c.surface, minWidth: 0,
  },
  itemMobile: {
    display: 'flex', flexDirection: 'column', alignItems: 'stretch',
    padding: '12px 16px', borderRadius: radius.lg, border: `1px solid ${c.border}`,
    background: c.surface, gap: 10,
  },
  itemInfo: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
  rootName: { color: c.text, fontSize: 13, fontWeight: 500 },
  rootPath: { color: c.textMuted, fontSize: 12, fontFamily: font.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'flex', gap: 8, flexShrink: 0, marginLeft: 12 },
  actionsMobile: { display: 'flex', gap: 8, marginLeft: 0 },
  actionBtn: {
    padding: '5px 14px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', cursor: 'pointer', fontSize: 12,
    fontWeight: 500, transition: 'all 0.15s',
  },
};
