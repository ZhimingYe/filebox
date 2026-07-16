import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo, CollectionInfo, CollectionItem, FsEntry } from '../api/client';
import * as api from '../api/client';
import { c, radius, font } from '../theme';
import { PreviewWorkspace } from './PreviewWorkspace';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import type { usePreviewTabs } from '../hooks/usePreviewTabs';
import { IconClose } from './icons';

interface Props {
  agent: AgentInfo;
  previewTabs: ReturnType<typeof usePreviewTabs>;
  splitRatio: number;
  onOpenInFiles: (root: string, path: string) => void;
  onRefresh: () => void;
}

type ItemStatus = 'ok' | 'missing' | 'denied' | 'unknown';

interface DisplayItem extends CollectionItem {
  id: string;
  basename: string;
  status: ItemStatus;
}

function basenameFromPath(path: string): string {
  const p = path.endsWith('/') && path.length > 1 ? path.replace(/\/+$/, '') : path;
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function CollectionsView({ agent, previewTabs, splitRatio, onOpenInFiles, onRefresh }: Props) {
  const collections = agent.collections ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(collections[0]?.name ?? null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const statusCache = useRef<Map<string, ItemStatus>>(new Map());

  useEffect(() => {
    if (collections.length === 0) {
      setSelectedName(null);
      return;
    }
    if (!selectedName || !collections.some((c) => c.name === selectedName)) {
      setSelectedName(collections[0].name);
    }
  }, [collections, selectedName]);

  const selected = useMemo(
    () => collections.find((c) => c.name === selectedName) ?? null,
    [collections, selectedName],
  );

  const displayItems: DisplayItem[] = useMemo(() => {
    if (!selected) return [];
    return selected.items.map((item, idx) => {
      const id = `${item.root}:${item.path}:${idx}`;
      return {
        ...item,
        id,
        basename: item.label?.trim() || basenameFromPath(item.path),
        status: statusCache.current.get(id) ?? 'unknown',
      };
    });
  }, [selected]);

  // Probe file existence for cosmetic status badges.
  useEffect(() => {
    if (!selected || agent.status !== 'online') return;
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      for (let i = 0; i < selected.items.length; i++) {
        if (cancelled) return;
        const item = selected.items[i];
        const id = `${item.root}:${item.path}:${i}`;
        try {
          const res = await api.fsStat(agent.id, item.root, item.path, abort.signal);
          let status: ItemStatus = 'ok';
          if (res.error || !res.stat) status = 'missing';
          else if (res.stat.denied) status = 'denied';
          else if (res.stat.entry_type !== 'file') status = 'missing';
          statusCache.current.set(id, status);
        } catch {
          /* offline / aborted — leave unknown */
        }
      }
      if (!cancelled) {
        // Force re-render to pick up cache updates.
        setHoveredId((v) => v);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [agent.id, agent.status, selected]);

  const openItem = useCallback(
    async (item: CollectionItem) => {
      setError(null);
      try {
        const res = await api.fsStat(agent.id, item.root, item.path);
        if (res.error || !res.stat) {
          setError('File not found');
          return;
        }
        if (res.stat.denied) {
          setError('Access denied');
          return;
        }
        if (res.stat.entry_type !== 'file') {
          setError('Not a file');
          return;
        }
        previewTabs.openOrActivate({
          agentId: agent.id,
          root: item.root,
          path: item.path,
          entry: res.stat as FsEntry,
        });
      } catch (e: any) {
        setError(api.friendlyMessage(e));
      }
    },
    [agent.id, previewTabs],
  );

  const removeItem = useCallback(
    async (item: CollectionItem) => {
      if (!selected) return;
      setBusy(true);
      setError(null);
      try {
        await api.patchCollection(agent.id, selected.name, {
          item_remove: { root: item.root, path: item.path },
        });
        onRefresh();
      } catch (e: any) {
        setError(api.friendlyMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [agent.id, onRefresh, selected],
  );

  const createCollection = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCollection(agent.id, name);
      setNewName('');
      setNewOpen(false);
      setSelectedName(name);
      onRefresh();
    } catch (e: any) {
      setError(api.friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCollection(agent.id, selected.name);
      onRefresh();
    } catch (e: any) {
      setError(api.friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const activeTab = previewTabs.activeTab;
  const listWidthPct = splitRatio * 100;

  if (collections.length === 0) {
    return (
      <div style={styles.emptyWrap}>
        <p style={styles.emptyTitle}>No collections on this agent</p>
        <p style={styles.emptyHint}>
          Create a collection to group files from different roots for preview.
        </p>
        {error && <p style={styles.errorText}>{error}</p>}
        {newOpen ? (
          <div style={styles.newRow}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createCollection();
                if (e.key === 'Escape') setNewOpen(false);
              }}
              placeholder="Collection name"
              style={styles.input}
            />
            <button type="button" disabled={busy} onClick={createCollection} style={styles.btn}>
              Create
            </button>
          </div>
        ) : (
          <button type="button" disabled={busy} onClick={() => setNewOpen(true)} style={styles.btnPrimary}>
            New collection
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <select
          value={selectedName ?? ''}
          onChange={(e) => setSelectedName(e.target.value)}
          style={styles.select}
        >
          {collections.map((c: CollectionInfo) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => setNewOpen((v) => !v)} style={styles.btn}>
          + New
        </button>
        <button type="button" disabled={busy || !selected} onClick={deleteSelected} style={styles.btnDanger}>
          Delete
        </button>
        {agent.pending_collections_update && (
          <span style={styles.pendingBadge}>Pending sync</span>
        )}
      </div>
      {newOpen && (
        <div style={styles.newBar}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createCollection()}
            placeholder="New collection name"
            style={styles.input}
          />
          <button type="button" disabled={busy} onClick={createCollection} style={styles.btn}>
            Create
          </button>
        </div>
      )}
      {error && <div style={styles.errorBar}>{error}</div>}

      <div style={styles.split}>
        <div style={{ ...styles.listPane, width: `${listWidthPct}%` }}>
          {!selected || selected.items.length === 0 ? (
            <div style={styles.listEmpty}>
              Empty collection — add files from the Files browser.
            </div>
          ) : (
            <div style={styles.list}>
              {displayItems.map((item) => {
                const muted = item.status === 'missing' || item.status === 'denied';
                const isActive = activeTab?.root === item.root && activeTab?.path === item.path;
                return (
                  <div
                    key={item.id}
                    style={{
                      ...styles.row,
                      ...(hoveredId === item.id ? styles.rowHover : {}),
                      ...(isActive ? styles.rowActive : {}),
                      opacity: muted ? 0.55 : 1,
                    }}
                    onMouseEnter={() => setHoveredId(item.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => openItem(item)}
                  >
                    <div style={styles.rowMain}>
                      <div style={styles.rowTitle}>{item.basename}</div>
                      <div style={styles.rowMeta}>
                        {item.root} · {item.path}
                        {item.status === 'missing' && ' · not found'}
                        {item.status === 'denied' && ' · denied'}
                      </div>
                    </div>
                    <div style={styles.rowActions}>
                      <button
                        type="button"
                        title="Open in Files"
                        style={styles.iconBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          const dir = item.path.replace(/\/[^/]+$/, '') || '/';
                          onOpenInFiles(item.root, dir);
                        }}
                      >
                        Files
                      </button>
                      <button
                        type="button"
                        title="Remove from collection"
                        style={styles.iconBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeItem(item);
                        }}
                      >
                        <IconClose style={{ width: 12, height: 12 }} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={styles.previewPane}>
          {activeTab ? (
            <PreviewErrorBoundary key={activeTab.id}>
              <PreviewWorkspace
                agentId={agent.id}
                tabs={previewTabs.tabs}
                activeTab={activeTab}
                activeTabId={previewTabs.activeTabId}
                onActivate={previewTabs.activate}
                onClose={previewTabs.close}
                onCloseAll={previewTabs.closeAll}
                onCloseLeft={previewTabs.closeLeft}
                onCloseRight={previewTabs.closeRight}
              />
            </PreviewErrorBoundary>
          ) : (
            <div style={styles.previewPlaceholder}>Select a file to preview</div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    borderBottom: `1px solid ${c.border}`, flexShrink: 0,
  },
  select: {
    fontSize: 13, padding: '4px 8px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: c.bgSubtle, color: c.text,
    fontFamily: font.sans, minWidth: 140,
  },
  btn: {
    padding: '4px 10px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: c.bgSubtle, color: c.text, cursor: 'pointer', fontSize: 12,
    fontFamily: font.sans,
  },
  btnPrimary: {
    padding: '6px 14px', borderRadius: radius.sm, border: 'none',
    background: c.accent, color: c.onAccent, cursor: 'pointer', fontSize: 13,
    fontFamily: font.sans, fontWeight: 600,
  },
  btnDanger: {
    padding: '4px 10px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.danger, cursor: 'pointer', fontSize: 12,
    fontFamily: font.sans,
  },
  pendingBadge: {
    fontSize: 11, color: c.warning, background: c.warningBg,
    padding: '2px 8px', borderRadius: radius.pill,
  },
  newBar: {
    display: 'flex', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
  },
  newRow: { display: 'flex', gap: 8, marginTop: 12 },
  input: {
    flex: 1, fontSize: 13, padding: '6px 8px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: c.bgSubtle, color: c.text,
    fontFamily: font.sans,
  },
  errorBar: { fontSize: 12, color: c.danger, padding: '6px 12px' },
  errorText: { fontSize: 12, color: c.danger, marginTop: 8 },
  split: { display: 'flex', flex: 1, minHeight: 0 },
  listPane: {
    borderRight: `1px solid ${c.border}`, overflowY: 'auto', minWidth: 200,
  },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    borderBottom: `1px solid ${c.borderSubtle}`, cursor: 'pointer',
  },
  rowHover: { background: c.bgMuted },
  rowActive: { background: c.accentBg },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', color: c.text,
  },
  rowMeta: {
    fontSize: 11, color: c.textMuted, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontFamily: font.mono, marginTop: 2,
  },
  rowActions: { display: 'flex', gap: 4, flexShrink: 0 },
  iconBtn: {
    padding: '2px 6px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 10, fontFamily: font.sans,
  },
  listEmpty: { padding: 16, color: c.textMuted, fontSize: 13 },
  previewPane: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
  previewPlaceholder: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: c.textMuted, fontSize: 13,
  },
  emptyWrap: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24, textAlign: 'center',
  },
  emptyTitle: { fontSize: 15, fontWeight: 600, color: c.text, margin: 0 },
  emptyHint: { fontSize: 13, color: c.textMuted, marginTop: 8, maxWidth: 360 },
};
