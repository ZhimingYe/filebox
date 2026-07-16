import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, CollectionInfo } from '../api/client';
import * as api from '../api/client';
import { c, radius, shadow, font, menuList, menuListItemStyle } from '../theme';

interface TargetFile {
  root: string;
  path: string;
}

interface Props {
  agent: AgentInfo;
  target: TargetFile;
  anchorRect: DOMRect;
  onClose: () => void;
  onChanged: () => void;
}

export function CollectionPicker({ agent, target, anchorRect, onClose, onChanged }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const collections = agent.collections ?? [];

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const addTo = async (coll: CollectionInfo) => {
    setBusy(coll.name);
    setError(null);
    try {
      await api.patchCollection(agent.id, coll.name, {
        item_add: { root: target.root, path: target.path },
      });
      onChanged();
      onClose();
    } catch (e: any) {
      setError(api.friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy('__create__');
    setError(null);
    try {
      await api.createCollection(agent.id, name);
      await api.patchCollection(agent.id, name, {
        item_add: { root: target.root, path: target.path },
      });
      onChanged();
      onClose();
    } catch (e: any) {
      setError(api.friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const panelTop = Math.min(anchorRect.bottom + 4, window.innerHeight - 280);
  const panelLeft = Math.min(anchorRect.left, window.innerWidth - 240);

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: panelTop,
        left: panelLeft,
        zIndex: 2000,
        width: 220,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: radius.md,
        boxShadow: shadow.lg,
        padding: 6,
        fontFamily: font.sans,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: c.textSecondary, padding: '4px 6px 6px' }}>
        Add to collection
      </div>
      {error && (
        <div style={{ fontSize: 11, color: c.danger, padding: '0 6px 6px' }}>{error}</div>
      )}
      <div style={{ ...menuList, maxHeight: 180, overflowY: 'auto' }}>
        {collections.length === 0 && !creating && (
          <div style={{ fontSize: 12, color: c.textMuted, padding: '6px 8px' }}>
            No collections yet
          </div>
        )}
        {collections.map((coll) => {
          const already = coll.items.some(
            (i) => i.root === target.root && i.path === target.path,
          );
          return (
            <button
              key={coll.name}
              type="button"
              disabled={!!busy || already}
              style={{
                ...menuListItemStyle({ selected: false, hovered: hovered === coll.name }),
                opacity: already ? 0.45 : 1,
              }}
              onMouseEnter={() => setHovered(coll.name)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => addTo(coll)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {busy === coll.name ? 'Adding…' : coll.name}
                {already ? ' (added)' : ''}
              </span>
            </button>
          );
        })}
      </div>
      {creating ? (
        <div style={{ display: 'flex', gap: 4, padding: '6px 4px 2px' }}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createAndAdd();
              if (e.key === 'Escape') setCreating(false);
            }}
            placeholder="Collection name"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              padding: '4px 6px',
              borderRadius: radius.sm,
              border: `1px solid ${c.border}`,
              background: c.bgSubtle,
              color: c.text,
              fontFamily: font.sans,
            }}
          />
          <button
            type="button"
            disabled={!!busy || !newName.trim()}
            onClick={createAndAdd}
            style={styles.smallBtn}
          >
            {busy === '__create__' ? '…' : 'Add'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!!busy}
          style={{ ...styles.smallBtn, width: '100%', marginTop: 4 }}
          onClick={() => setCreating(true)}
        >
          New collection…
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  smallBtn: {
    padding: '4px 8px',
    borderRadius: radius.sm,
    border: `1px solid ${c.border}`,
    background: c.bgSubtle,
    color: c.text,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: font.sans,
  },
};
