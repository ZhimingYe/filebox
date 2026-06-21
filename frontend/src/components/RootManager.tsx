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

export function RootManager({ agentId, roots, onUpdate }: Props) {
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();

  const handleAdd = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await api.addRoot(agentId, newName.trim(), newPath.trim());
      setNewName('');
      setNewPath('');
      onUpdate();
    } catch (e: any) {
      setError(friendlyMessage(e));
    } finally {
      setLoading(false);
    }
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
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name"
          style={isMobile ? styles.inputMobile : styles.input}
        />
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/path/to/directory"
          style={isMobile ? styles.inputMobile : { ...styles.input, flex: 2 }}
        />
        <button
          onClick={handleAdd}
          disabled={loading || !newName.trim() || !newPath.trim()}
          style={isMobile ? styles.addBtnMobile : styles.addBtn}
        >
          Add
        </button>
      </div>

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
  addRow: { display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' },
  addRowMobile: {
    display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20,
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
