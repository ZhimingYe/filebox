import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, radius, font } from '../theme';
import { IconUpload, IconTrash, IconCheck, IconClipboard } from './icons';
import { FileDownloadLink } from './FileDownloadLink';
import { formatDate, formatSize } from './fileListShared';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useIsMobile } from '../state/useIsMobile';

interface Props {
  agent: api.AgentInfo;
  /** Files handed over by the app-level drop zone; nonce re-arms uploads. */
  uploadRequest?: { files: File[]; nonce: number } | null;
  onUploadsHandled?: () => void;
  /** Bumped by the parent on SSE `temp_updated` so other tabs stay in sync. */
  tempRefreshNonce?: number;
}

interface UploadItem {
  id: number;
  name: string;
  state: 'uploading' | 'done' | 'error';
  pct: number | null;
  message?: string;
}

/**
 * Dedicated temp-folder transfer view: drop files onto the agent's scratch
 * folder, see what is already there, download it back, or clear it. This is
 * the ONLY write path in the product; it lives outside the file manager
 * because the temp folder is not a workspace root (no tree, no pins, no
 * search scope, no settings row).
 */
export function TempTransferView({ agent, uploadRequest, onUploadsHandled, tempRefreshNonce }: Props) {
  const root = agent.temp_root_name ?? null;
  const isMobile = useIsMobile();
  const { copiedPath, copyToClipboard } = useCopyToClipboard();

  const [files, setFiles] = useState<api.FsEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [cleanupState, setCleanupState] = useState<{
    busy: boolean;
    result?: string;
    error?: string;
  }>({ busy: false });
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never setState after unmount (agent switch / view teardown).
  useEffect(() => () => {
    if (uploadClearTimer.current) clearTimeout(uploadClearTimer.current);
    if (cleanupDismissTimer.current) clearTimeout(cleanupDismissTimer.current);
  }, []);

  const loadFiles = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    setListError(null);
    try {
      const data = await api.fsList(agent.id, root, '/', 1000, undefined, false);
      // Uploads only ever produce flat files; ignore anything else that a
      // local actor may have dropped in manually.
      setFiles(data.items.filter((i) => i.entry_type === 'file'));
      setNextCursor(data.next_cursor ?? null);
    } catch (e) {
      setListError(friendlyMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agent.id, root]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // A remote temp update (other tab, or the folder changed on the agent)
  // re-lists.
  useEffect(() => {
    if (!tempRefreshNonce) return;
    void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempRefreshNonce]);

  const patchUpload = useCallback((id: number, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  // Upload files sequentially. Progress per file, honest per-file
  // success/error state, and the list re-loads after each completed upload.
  const runUploads = useCallback(async (incoming: File[]) => {
    if (!root || incoming.length === 0) return;
    const base = Date.now();
    const items: UploadItem[] = incoming.map((file, i) => ({
      id: base + i,
      name: file.name,
      state: 'uploading',
      pct: 0,
    }));
    setUploads((prev) => [...prev, ...items]);
    for (let i = 0; i < incoming.length; i++) {
      const file = incoming[i];
      const item = items[i];
      if (agent.temp_max_file_bytes != null && file.size > agent.temp_max_file_bytes) {
        patchUpload(item.id, {
          state: 'error',
          pct: null,
          message: friendlyMessage({ error: 'temp_file_too_large' }),
        });
        continue;
      }
      try {
        await api.uploadTempFile(agent.id, file, (loaded, total) => {
          if (total > 0) {
            patchUpload(item.id, { pct: Math.min(99, Math.round((loaded / total) * 100)) });
          }
        });
        patchUpload(item.id, { state: 'done', pct: 100 });
        await loadFiles();
      } catch (e) {
        patchUpload(item.id, { state: 'error', pct: null, message: friendlyMessage(e) });
      }
    }
    // Completed/errored rows stay visible briefly, then fade out.
    if (uploadClearTimer.current) clearTimeout(uploadClearTimer.current);
    uploadClearTimer.current = setTimeout(() => {
      setUploads((prev) => prev.filter((u) => u.state === 'uploading'));
    }, 8000);
  }, [agent.id, agent.temp_max_file_bytes, root, loadFiles, patchUpload]);

  // App-level drop zone hands files over via this nonce.
  useEffect(() => {
    if (!uploadRequest || uploadRequest.nonce === 0) return;
    void runUploads(uploadRequest.files);
    onUploadsHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadRequest?.nonce]);

  // One-click cleanup of the whole temp folder.
  const handleCleanup = useCallback(async () => {
    if (cleanupState.busy) return;
    setCleanupState({ busy: true });
    try {
      const res = await api.cleanupTempFolder(agent.id);
      const items = `${res.removed} item${res.removed === 1 ? '' : 's'}`;
      setCleanupState({
        busy: false,
        result: `Cleaned the temp folder: removed ${items} (${formatSize(res.freed_bytes)})`,
      });
      void loadFiles();
    } catch (e) {
      setCleanupState({ busy: false, error: friendlyMessage(e) });
    }
  }, [agent.id, cleanupState.busy, loadFiles]);

  // Auto-dismiss the cleanup banner.
  useEffect(() => {
    if (!cleanupState.result && !cleanupState.error) return;
    if (cleanupDismissTimer.current) clearTimeout(cleanupDismissTimer.current);
    cleanupDismissTimer.current = setTimeout(
      () => setCleanupState({ busy: false }),
      6000,
    );
    return () => {
      if (cleanupDismissTimer.current) clearTimeout(cleanupDismissTimer.current);
    };
  }, [cleanupState.result, cleanupState.error]);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  // Drops inside the view are owned by the view: stop propagation so the
  // app-wide window drop listener (App.tsx) does not also upload the same
  // files, and the global overlay does not fight the view's own highlight.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length > 0) void runUploads(dropped);
  };

  if (!root) return null;

  // Header and rows share one template so SIZE / MODIFIED sit above their
  // values. The trailing track is reserved for Copy path + download; an
  // auto-sized action cell would collapse in the header (empty) and shift
  // the meta columns relative to the data row.
  const gridTemplateColumns = isMobile
    ? 'minmax(0, 1fr) 72px 68px'
    : 'minmax(0, 1fr) 92px 110px 128px';

  return (
    <div
      style={styles.root}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div style={styles.header}>
        <div style={styles.headerText}>
          <h2 style={styles.title}>Transfer</h2>
          <p style={styles.subtitle}>
            Upload small files to the agent&rsquo;s dedicated temp folder
            {agent.temp_max_file_bytes != null
              ? ` (up to ${formatSize(agent.temp_max_file_bytes)} per file)`
              : ''}.
          </p>
          {agent.temp_root_path && (
            <button
              type="button"
              onClick={() => {
                if (!agent.temp_root_path) return;
                void copyToClipboard(agent.temp_root_path, 'folder-path');
              }}
              style={styles.pathRow}
              title="Copy the temp folder's absolute path on the agent"
            >
              <span style={styles.pathLabel}>Folder on agent</span>
              <span style={styles.pathValue}>{agent.temp_root_path}</span>
              <span
                style={{
                  ...styles.pathCopy,
                  ...(copiedPath === 'folder-path' ? styles.pathCopyActive : {}),
                }}
              >
                {copiedPath === 'folder-path' ? 'Copied' : 'Copy'}
              </span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleCleanup()}
          disabled={cleanupState.busy}
          style={{
            ...styles.cleanBtn,
            ...(cleanupState.busy ? styles.btnDisabled : {}),
          }}
          title="Delete every file in the temp folder"
          aria-label="Clean the temp folder"
        >
          <IconTrash />
          {cleanupState.busy ? 'Cleaning…' : 'Clean'}
        </button>
      </div>

      {/* Drop zone — also the click-to-choose fallback (touch devices). */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        style={{
          ...styles.dropZone,
          ...(dragOver ? styles.dropZoneActive : {}),
        }}
        title="Choose files to upload"
      >
        <IconUpload style={styles.dropIcon} />
        <span style={styles.dropText}>
          {dragOver ? 'Drop to upload' : 'Drop files here, or click to choose'}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const list = e.target.files;
          if (list) void runUploads(Array.from(list));
          e.target.value = '';
        }}
      />

      {uploads.length > 0 && (
        <div style={styles.uploadList} role="status">
          {uploads.map((u) => (
            <div key={u.id} style={styles.uploadRow}>
              <span style={styles.uploadName}>{u.name}</span>
              <span
                style={{
                  ...styles.uploadState,
                  color:
                    u.state === 'error' ? c.danger
                      : u.state === 'done' ? c.success
                        : c.textSecondary,
                }}
              >
                {u.state === 'uploading'
                  ? u.pct != null ? `${u.pct}%` : '…'
                  : u.state === 'done'
                    ? 'Uploaded'
                    : u.message || 'Upload failed'}
              </span>
            </div>
          ))}
        </div>
      )}

      {cleanupState.result && (
        <div style={styles.cleanupBanner} role="status">
          <IconCheck style={{ width: 14, height: 14 }} />
          <span>{cleanupState.result}</span>
        </div>
      )}
      {cleanupState.error && (
        <div style={styles.cleanupBannerError} role="alert">
          {cleanupState.error}
        </div>
      )}
      {listError && (
        <div style={styles.errorBox} role="alert">
          <span style={styles.errorTitle}>Could not list the temp folder</span>
          <p style={styles.errorBody}>{listError}</p>
        </div>
      )}

      <div style={styles.listCard}>
        <div style={{ ...styles.listHeader, gridTemplateColumns }}>
          <span style={styles.colName}>Name</span>
          <span style={styles.colSize}>Size</span>
          {!isMobile && <span style={styles.colDate}>Modified</span>}
          <span style={styles.colAction} />
        </div>
        {loading && files.length === 0 ? (
          <div style={styles.empty}>Loading…</div>
        ) : files.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyTitle}>No files yet</p>
            <p style={styles.emptyBody}>
              Drop files above to copy them onto the agent.
            </p>
          </div>
        ) : (
          files.map((f, i) => (
            <div
              key={f.name}
              style={{
                ...styles.row,
                gridTemplateColumns,
                ...(i === files.length - 1 ? { borderBottom: 'none' } : {}),
              }}
            >
              <span style={styles.colName} title={f.name}>{f.name}</span>
              <span style={styles.colSize}>{formatSize(f.size ?? 0)}</span>
              {!isMobile && (
                <span style={styles.colDate}>{f.modified ? formatDate(f.modified) : '—'}</span>
              )}
              <span style={styles.colAction}>
                <button
                  type="button"
                  onClick={() => {
                    if (!agent.temp_root_path) return;
                    void copyToClipboard(`${agent.temp_root_path}/${f.name}`, `path-${f.name}`);
                  }}
                  style={{
                    ...styles.pathBtn,
                    ...(isMobile ? styles.pathBtnIcon : {}),
                    ...(copiedPath === `path-${f.name}` ? styles.pathBtnActive : {}),
                  }}
                  title="Copy the file's absolute path on the agent (e.g. to hand to a CLI agent)"
                  aria-label={`Copy path of ${f.name}`}
                >
                  {copiedPath === `path-${f.name}`
                    ? (isMobile ? <IconCheck /> : 'Copied')
                    : (isMobile ? <IconClipboard /> : 'Copy path')}
                </button>
                {f.denied ? (
                  <span style={styles.deniedTag}>denied</span>
                ) : (
                  <FileDownloadLink
                    agentId={agent.id}
                    root={root}
                    path={`/${f.name}`}
                    style={styles.downloadBtn}
                    title="Download"
                    aria-label={`Download ${f.name}`}
                  >
                    <IconUpload style={styles.downloadIcon} />
                  </FileDownloadLink>
                )}
              </span>
            </div>
          ))
        )}
        {nextCursor && (
          <p style={styles.truncated}>
            Showing the first {files.length} files; the folder has more.
          </p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '20px 24px',
    maxWidth: 900,
    minWidth: 0,
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontFamily: font.sans,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  headerText: {
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: 17,
    fontWeight: 600,
    color: c.text,
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textMuted,
  },
  cleanBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    padding: '8px 14px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
    transition: 'color 0.12s, border-color 0.12s, opacity 0.12s',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'wait',
  },
  dropZone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '34px 16px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.border,
    background: c.bgSubtle,
    cursor: 'pointer',
    color: c.textSecondary,
    fontFamily: font.sans,
    transition: 'border-color 0.15s, background 0.15s',
  },
  dropZoneActive: {
    borderColor: c.accent,
    background: c.bgMuted,
  },
  dropIcon: {
    width: 26,
    height: 26,
    color: c.textSecondary,
  },
  dropText: {
    fontSize: 13.5,
    fontWeight: 500,
    color: c.text,
  },
  uploadList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: '8px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    maxHeight: 140,
    overflowY: 'auto',
  },
  uploadRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    fontSize: 12.5,
    fontFamily: font.sans,
  },
  uploadName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: c.text,
  },
  uploadState: { flexShrink: 0, fontWeight: 500 },
  cleanupBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    fontSize: 12.5,
    fontFamily: font.sans,
    color: c.success,
  },
  cleanupBannerError: {
    padding: '8px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.danger}25`,
    background: c.dangerBg,
    fontSize: 12.5,
    fontFamily: font.sans,
    color: c.danger,
  },
  errorBox: {
    padding: '10px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.danger}25`,
    background: c.dangerBg,
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
  listCard: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    overflow: 'hidden',
  },
  listHeader: {
    display: 'grid',
    alignItems: 'center',
    columnGap: 12,
    padding: '8px 14px',
    borderBottom: `1px solid ${c.border}`,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
    color: c.textMuted,
    fontFamily: font.sans,
    width: '100%',
    boxSizing: 'border-box',
  },
  row: {
    display: 'grid',
    alignItems: 'center',
    columnGap: 12,
    padding: '8px 14px',
    borderBottom: `1px solid ${c.borderSubtle}`,
    fontSize: 12.5,
    fontFamily: font.sans,
    width: '100%',
    boxSizing: 'border-box',
  },
  colName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: c.text,
  },
  colSize: {
    minWidth: 0,
    textAlign: 'right',
    color: c.textSecondary,
    fontFamily: font.mono,
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  colDate: {
    minWidth: 0,
    textAlign: 'right',
    color: c.textMuted,
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  colAction: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    minWidth: 0,
    width: '100%',
  },
  pathBtn: {
    padding: '4px 10px',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    boxSizing: 'border-box',
    transition: 'color 0.12s, border-color 0.12s, background 0.12s',
  },
  pathBtnIcon: {
    padding: 0,
    width: 28,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pathBtnActive: {
    borderColor: c.accent,
    background: c.accentBg,
    color: c.accent,
  },
  deniedTag: {
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
    color: c.textMuted,
    background: c.bgMuted,
    padding: '2px 6px',
    borderRadius: radius.sm,
  },
  downloadBtn: {
    padding: 0,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    width: 28,
    height: 26,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
  },
  downloadIcon: {
    display: 'block',
    // The shared upload arrow flipped — "download" affordance.
    transform: 'rotate(180deg)',
  },
  pathRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: '6px 10px',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.borderSubtle,
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: font.sans,
    maxWidth: '100%',
  },
  pathLabel: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
    color: c.textMuted,
  },
  pathValue: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontFamily: font.mono,
    color: c.textSecondary,
  },
  pathCopy: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 500,
    color: c.textSecondary,
  },
  pathCopyActive: {
    color: c.accent,
  },
  empty: {
    padding: '28px 16px',
    textAlign: 'center',
    color: c.textMuted,
    fontSize: 12.5,
    fontFamily: font.sans,
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
  truncated: {
    margin: 0,
    padding: '8px 14px',
    fontSize: 12,
    color: c.textMuted,
    fontFamily: font.sans,
  },
};
