import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo, CollectionInfo, CollectionItem } from '../api/client';
import * as api from '../api/client';
import { statToFsEntry } from '../api/client';
import { c, radius, font } from '../theme';
import { PreviewWorkspace } from './PreviewWorkspace';
import { WorkspaceSplit } from './WorkspaceSplit';
import { FileEntryList, type FileEntryListRowModel } from './FileEntryList';
import { fileListStyles, sortFileListRows, type FileListSortKey } from './fileListShared';
import type { usePreviewTabs } from '../hooks/usePreviewTabs';
import { useIsMobile } from '../state/useIsMobile';

interface Props {
  agent: AgentInfo;
  previewTabs: ReturnType<typeof usePreviewTabs>;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  onOpenInFiles: (root: string, path: string) => void;
  onRefresh: () => void;
  /** Mobile: hide file list while preview is fullscreen in App. */
  hideList?: boolean;
  /** Mobile: preview is rendered by App, not inline here. */
  hidePreview?: boolean;
}

type ItemStatus = 'ok' | 'missing' | 'denied' | 'unknown';

interface ItemMeta {
  status: ItemStatus;
  size: number | null;
  modified: string | null;
}

function basenameFromPath(path: string): string {
  const p = path.endsWith('/') && path.length > 1 ? path.replace(/\/+$/, '') : path;
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function CollectionsView({
  agent,
  previewTabs,
  splitRatio,
  onSplitRatioChange,
  onOpenInFiles,
  onRefresh,
  hideList = false,
  hidePreview = false,
}: Props) {
  const isMobile = useIsMobile();
  const collections = agent.collections ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(collections[0]?.name ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [metaVersion, setMetaVersion] = useState(0);
  const [sortBy, setSortBy] = useState<FileListSortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const metaCache = useRef<Map<string, ItemMeta>>(new Map());

  const toggleSort = useCallback((key: FileListSortKey) => {
    if (sortBy === key) setSortAsc((a) => !a);
    else {
      setSortBy(key);
      setSortAsc(true);
    }
  }, [sortBy]);

  useEffect(() => {
    metaCache.current.clear();
    setMetaVersion((v) => v + 1);
  }, [selectedName]);

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

  // Stable fingerprint so health polling (new agent object every ~5s) does not
  // restart metadata probes when collection items are unchanged.
  const selectedItemsKey = useMemo(() => {
    if (!selectedName) return '';
    const col = collections.find((c) => c.name === selectedName);
    if (!col) return '';
    return col.items
      .map((item) => `${item.root}::${item.path}::${item.label ?? ''}`)
      .join('|');
  }, [collections, selectedName]);

  const selectedItems = useMemo(() => {
    if (!selectedName) return [] as CollectionItem[];
    return collections.find((c) => c.name === selectedName)?.items ?? [];
  // Re-read collections only when the item fingerprint changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedItemsKey tracks item content
  }, [selectedName, selectedItemsKey]);

  const activeTab = previewTabs.activeTab;
  const showInlinePreview = !hidePreview && !!activeTab && activeTab.agentId === agent.id;

  const rawListRows: FileEntryListRowModel[] = useMemo(() => {
    if (!selected) return [];
    return selected.items.map((item) => {
      const key = `${item.root}::${item.path}`;
      const meta = metaCache.current.get(key);
      const name = item.label?.trim() || basenameFromPath(item.path);
      const status = meta?.status ?? 'unknown';
      return {
        entry: {
          name,
          entry_type: 'file' as const,
          size: meta?.size ?? null,
          modified: meta?.modified ?? null,
          denied: status === 'denied',
        },
        fullPath: `${item.root}${item.path}`,
        rootLabel: item.root,
        unavailable: status === 'missing',
        data: item,
      };
    });
  }, [selected, metaVersion]);

  const listRows = useMemo(
    () => sortFileListRows(rawListRows, sortBy, sortAsc),
    [rawListRows, sortBy, sortAsc],
  );

  // Probe file metadata for status badges, size, and modified columns.
  useEffect(() => {
    if (selectedItems.length === 0 || agent.status !== 'online') return;
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      for (const item of selectedItems) {
        if (cancelled) return;
        const key = `${item.root}::${item.path}`;
        try {
          const res = await api.fsStat(agent.id, item.root, item.path, abort.signal);
          let status: ItemStatus = 'ok';
          let size: number | null = null;
          let modified: string | null = null;
          if (res.error || !res.stat) {
            status = 'missing';
          } else if (res.stat.denied) {
            status = 'denied';
          } else if (res.stat.entry_type !== 'file') {
            status = 'missing';
          } else {
            size = res.stat.size;
            modified = res.stat.modified;
          }
          metaCache.current.set(key, { status, size, modified });
          if (!cancelled) setMetaVersion((v) => v + 1);
        } catch {
          /* offline / aborted — leave unknown */
        }
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [agent.id, agent.status, selectedItems, selectedItemsKey]);

  const openItem = useCallback(
    async (item: CollectionItem) => {
      setError(null);
      const key = `${item.root}::${item.path}`;
      const cached = metaCache.current.get(key);
      if (cached?.status === 'missing') {
        setError('File not found');
        return;
      }
      if (cached?.status === 'denied') {
        setError('Access denied');
        return;
      }
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
        const entry = statToFsEntry(res.stat, item.path);
        const input = {
          agentId: agent.id,
          root: item.root,
          path: item.path,
          entry,
        };
        if (isMobile) {
          previewTabs.replaceAll(input);
        } else {
          previewTabs.openOrActivate(input);
        }
      } catch (e: any) {
        setError(api.friendlyMessage(e));
      }
    },
    [agent.id, isMobile, previewTabs],
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

  const handleSelectRow = useCallback(
    (row: FileEntryListRowModel) => {
      openItem(row.data as CollectionItem);
    },
    [openItem],
  );

  const handleOpenInFilesRow = useCallback(
    (row: FileEntryListRowModel) => {
      const item = row.data as CollectionItem;
      const dir = item.path.replace(/\/[^/]+$/, '') || '/';
      onOpenInFiles(item.root, dir);
    },
    [onOpenInFiles],
  );

  const handleRemoveRow = useCallback(
    (row: FileEntryListRowModel) => {
      removeItem(row.data as CollectionItem);
    },
    [removeItem],
  );

  const renderNameHoverActions = useCallback(
    (row: FileEntryListRowModel) => (
      <>
        <button
          type="button"
          title="Open in Files"
          style={fileListStyles.copyNameBtn}
          onClick={(e) => {
            e.stopPropagation();
            handleOpenInFilesRow(row);
          }}
        >
          <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          title="Remove from collection"
          style={fileListStyles.copyNameBtn}
          onClick={(e) => {
            e.stopPropagation();
            handleRemoveRow(row);
          }}
        >
          ×
        </button>
      </>
    ),
    [handleOpenInFilesRow, handleRemoveRow],
  );

  // ← → flip through collection files (same affordance as Files directory nav).
  useEffect(() => {
    if (isMobile || hidePreview || !activeTab || activeTab.agentId !== agent.id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const navigable = listRows.filter((r) => !r.entry.denied && !r.unavailable);
      const currentKey = `${activeTab.root}::${activeTab.path}`;
      const idx = navigable.findIndex((r) => {
        const item = r.data as CollectionItem;
        return `${item.root}::${item.path}` === currentKey;
      });
      if (idx === -1) return;
      const nextIdx = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= navigable.length) return;
      e.preventDefault();
      openItem(navigable[nextIdx].data as CollectionItem);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isMobile, hidePreview, activeTab, agent.id, listRows, openItem]);

  if (collections.length === 0) {
    return (
      <div style={styles.emptyWrap}>
        <p style={styles.emptyTitle}>No collections</p>
        <p style={styles.emptyHint}>Group files across roots.</p>
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

      {!hideList && (
        <WorkspaceSplit
          splitRatio={splitRatio}
          onSplitRatioChange={onSplitRatioChange}
          showPreview={showInlinePreview}
          style={{ flex: 1 }}
          list={(
            <FileEntryList
              rows={listRows}
              sortBy={sortBy}
              sortAsc={sortAsc}
              onToggleSort={toggleSort}
              showRootColumn
              emptyMessage="Empty — add from Files."
              onRowClick={(row) => handleSelectRow(row)}
              renderNameHoverActions={renderNameHoverActions}
            />
          )}
          preview={(
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
          )}
        />
      )}
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
    fontFamily: font.sans, fontWeight: 600, marginTop: 28,
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
  newRow: { display: 'flex', gap: 8, marginTop: 28 },
  input: {
    flex: 1, fontSize: 13, padding: '6px 8px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: c.bgSubtle, color: c.text,
    fontFamily: font.sans,
  },
  errorBar: { fontSize: 12, color: c.danger, padding: '6px 12px' },
  errorText: { fontSize: 12, color: c.danger, marginTop: 12 },
  emptyWrap: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24, textAlign: 'center',
  },
  emptyTitle: { fontSize: 15, fontWeight: 600, color: c.text, margin: 0 },
  emptyHint: { fontSize: 13, color: c.textMuted, marginTop: 8, maxWidth: 360 },
};
