import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, CollectionInfo } from '../api/client';
import * as api from '../api/client';
import { c, font, menuList, menuListItemStyle, menuListSubStyle } from '../theme';
import { IconClose } from './icons';

interface TargetFile {
  root: string;
  path: string;
}

interface Props {
  agent: AgentInfo;
  target: TargetFile;
  anchorEl: HTMLElement;
  onClose: () => void;
  onChanged: () => void;
}

type PanelPos = {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
};

const PANEL_WIDTH = 280;

export function CollectionPicker({ agent, target, anchorEl, onClose, onChanged }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchorEl);
  anchorRef.current = anchorEl;

  const [panelPos, setPanelPos] = useState<PanelPos | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const collections = agent.collections ?? [];

  const placePanel = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    // Prefer below when there is room; otherwise flip above. When flipping,
    // anchor with CSS `bottom` (not a guessed `top`) so a short panel stays
    // glued to the trigger instead of floating mid-viewport under a 280px
    // height estimate.
    const openBelow = spaceBelow >= 160 || spaceBelow >= spaceAbove;
    const maxHeight = openBelow
      ? Math.max(120, Math.min(360, spaceBelow - gap))
      : Math.max(120, Math.min(360, spaceAbove - gap));
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - PANEL_WIDTH - margin),
    );
    const next: PanelPos = openBelow
      ? { top: rect.bottom + gap, left, maxHeight }
      : {
          // Panel bottom edge sits just above the trigger; content height
          // can change (create form, errors) without leaving a gap.
          bottom: window.innerHeight - rect.top + gap,
          left,
          maxHeight,
        };
    setPanelPos((prev) => {
      if (
        prev
        && prev.top === next.top
        && prev.bottom === next.bottom
        && prev.left === next.left
        && prev.maxHeight === next.maxHeight
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    placePanel();
    const onReposition = () => placePanel();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [placePanel]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const t = event.target as Node | null;
      if (panelRef.current && t && panelRef.current.contains(t)) return;
      if (anchorRef.current && t && anchorRef.current.contains(t)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (creating && (tag === 'INPUT' || tag === 'TEXTAREA')) {
        event.stopPropagation();
        event.preventDefault();
        setCreating(false);
        setNewName('');
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, creating]);

  const addTo = async (coll: CollectionInfo) => {
    setBusy(coll.name);
    setError(null);
    try {
      await api.patchCollection(agent.id, coll.name, {
        item_add: { root: target.root, path: target.path },
      });
      // Keep the panel open so the user can add the same file to more
      // collections, and so the list can flip to "(added)" in place.
      onChanged();
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
      // Single POST with initial item — avoids orphan empty collection if a
      // follow-up patch would fail after create.
      await api.createCollection(agent.id, name, {
        root: target.root,
        path: target.path,
      });
      setCreating(false);
      setNewName('');
      onChanged();
    } catch (e: any) {
      setError(api.friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!panelPos) return null;

  const targetLabel = `${target.root}${target.path}`;

  return (
    <div
      ref={panelRef}
      style={{
        ...styles.panel,
        top: panelPos.top,
        bottom: panelPos.bottom,
        left: panelPos.left,
        maxHeight: panelPos.maxHeight,
      }}
      role="dialog"
      aria-label="Add to collection"
      onMouseLeave={() => setHovered(null)}
    >
      <div style={styles.header}>
        <span>Add to collection</span>
        <button
          type="button"
          onClick={onClose}
          style={styles.closeBtn}
          aria-label="Close"
          title="Close"
        >
          <IconClose />
        </button>
      </div>
      <div style={styles.targetPath} title={targetLabel}>
        {targetLabel}
      </div>
      {error && (
        <div style={styles.error}>{error}</div>
      )}
      <div style={styles.list}>
        {collections.length === 0 && !creating && (
          <div style={styles.empty}>No collections yet</div>
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
              onClick={() => addTo(coll)}
            >
              <span style={menuList.itemTitle}>
                {busy === coll.name ? 'Adding…' : coll.name}
                {already ? ' (added)' : ''}
              </span>
              <span style={menuListSubStyle(false)}>
                {coll.items.length} item{coll.items.length === 1 ? '' : 's'}
              </span>
            </button>
          );
        })}
      </div>
      {creating ? (
        <div style={styles.createRow}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                createAndAdd();
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                setCreating(false);
                setNewName('');
              }
            }}
            placeholder="Collection name"
            style={styles.input}
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
          style={{ ...styles.smallBtn, ...styles.newBtn }}
          onClick={() => setCreating(true)}
        >
          New collection…
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    ...menuList.panel,
    position: 'fixed',
    zIndex: 2000,
    width: PANEL_WIDTH,
    maxWidth: `min(${PANEL_WIDTH}px, calc(100vw - 16px))`,
    padding: 0,
    gap: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: font.sans,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 8px 4px 12px',
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    color: c.textMuted,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
  },
  closeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    flexShrink: 0,
  },
  targetPath: {
    padding: '0 12px 8px',
    fontSize: 11,
    fontFamily: font.mono,
    color: c.textSecondary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  error: {
    fontSize: 11,
    color: c.danger,
    padding: '6px 12px 0',
    flexShrink: 0,
  },
  list: {
    padding: 4,
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  empty: {
    fontSize: 12,
    color: c.textMuted,
    padding: '6px 8px',
  },
  createRow: {
    display: 'flex',
    gap: 4,
    padding: '6px 8px 8px',
    flexShrink: 0,
    borderTop: `1px solid ${c.borderSubtle}`,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    padding: '4px 6px',
    borderRadius: 4,
    border: `1px solid ${c.border}`,
    background: c.bgSubtle,
    color: c.text,
    fontFamily: font.sans,
  },
  smallBtn: {
    padding: '4px 8px',
    borderRadius: 4,
    border: `1px solid ${c.border}`,
    background: c.bgSubtle,
    color: c.text,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: font.sans,
    flexShrink: 0,
  },
  newBtn: {
    margin: '0 8px 8px',
    width: 'calc(100% - 16px)',
  },
};
