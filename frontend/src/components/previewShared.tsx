import { useState, useEffect, useRef, useCallback } from 'react';
import { c, radius, font, shadow } from '../theme';
import { fsStat, withCsrf } from '../api/client';
import { fetchWithRetry, retryAsync, throwIfAgentError } from '../api/retry';
import { FileDownloadLink } from './FileDownloadLink';

// ── useMounted ────────────────────────────────────────────────────────────
// Prevents state updates after a component unmounts. Reset on each setup so
// React StrictMode's "setup → cleanup → setup" cycle doesn't leave us
// permanently unmounted after the first cleanup.

export function useMounted() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  return mountedRef;
}

// ── useFetchText ──────────────────────────────────────────────────────────
// Shared fetch hook with cancel + retry. Uses credentials: 'include' so the
// hub's session cookie is sent for /api/file/raw.
//
// Reports byte progress while the body streams (the hub sends 512 KiB
// chunks, so a 0.7 MB file on a slow agent link updates several times) and
// flips `slow` after 8s of no completion — the preview never freezes
// silently.

export function useFetchText(url: string, enabled = true, agentId?: string) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const cancelRef = useRef<AbortController | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    if (!enabled) {
      cancelRef.current?.abort();
      cancelRef.current = null;
      setText(null);
      setError(null);
      setLoading(false);
      setRetrying(false);
      setReceived(0);
      setTotal(null);
      setSlow(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    cancelRef.current = controller;
    setLoading(true);
    setError(null);
    setText(null);
    setRetrying(false);
    setReceived(0);
    setTotal(null);
    setSlow(false);
    slowTimerRef.current = setTimeout(() => {
      if (!cancelled) setSlow(true);
    }, 8000);

    void (async () => {
      try {
        const body = await fetchWithRetry(url, withCsrf({ signal: controller.signal }), {
          // Generous retry budget: under heavy load the first attempt may
          // 503 while the agent's content cache is still warming — each
          // retry is cheaper than the last, so keep trying.
          maxAttempts: 5,
          // No wall-clock cap: a slow-but-alive stream must be allowed to
          // finish (hub/agent timeouts still bound genuinely dead
          // connections). The 8s slow notice plus byte progress keep it
          // visibly alive.
          maxDurationMs: null,
          agentId,
          consume: async (res) => {
            const contentLength = Number(res.headers.get('content-length'));
            setTotal(Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null);
            const reader = res.body?.getReader();
            if (!reader) return res.text();
            // Stream the body so the overlay can show byte progress; decode
            // at the end (TextDecoder matches res.text()'s UTF-8 + BOM
            // handling).
            const chunks: Uint8Array[] = [];
            let receivedBytes = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                chunks.push(value);
                receivedBytes += value.byteLength;
                if (!cancelled) setReceived(receivedBytes);
              }
            }
            const merged = new Uint8Array(receivedBytes);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return new TextDecoder().decode(merged);
          },
          onRetry: () => {
            if (!cancelled) setRetrying(true);
          },
        });
        if (cancelled) return;
        setText(body);
        setLoading(false);
        setRetrying(false);
        setSlow(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { name?: string; message?: string };
        if (err?.name === 'AbortError') return;
        setError(err?.message || 'Failed to load file');
        setLoading(false);
        setRetrying(false);
        setSlow(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      cancelRef.current = null;
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };
  }, [url, retryToken, enabled, agentId]);

  const cancel = useCallback(() => {
    cancelRef.current?.abort();
    cancelRef.current = null;
    setLoading(false);
    setRetrying(false);
    setError('Cancelled');
  }, []);

  const retry = useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  // `enabled` can flip true one render before this effect has set `loading`
  // back to true. Treat an enabled request with neither text nor an error as
  // pending so consumers never render a null payload during that gap.
  const requestLoading = enabled && (loading || (text === null && error === null));
  return {
    text, error, loading: requestLoading, retrying, cancel, retry,
    received, total, slow,
  };
}

// ── byte formatting ───────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

// ── wrap preference ───────────────────────────────────────────────────────
// Module-level mutable so it persists across file switches (PreviewPane
// remounts with a new key when the user picks a different file).

export let wrapPref = true;

export function setWrapPref(v: boolean) {
  wrapPref = v;
}

// ── File-type maps ────────────────────────────────────────────────────────

// Values are Monaco language ids (not Prism). Unsupported langs fall back to
// the closest built-in highlighter or plaintext so the viewer still opens.
export const extToLang: Record<string, string> = {
  rs: 'rust', py: 'python',
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml', csv: 'plaintext',
  sql: 'sql', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  r: 'r', R: 'r',
  // R dotfiles: ".Rprofile" and ".Renviron" are R source/config files with no
  // real extension — `path.split('.').pop()` yields the lowercased basename
  // ("rprofile"/"renviron"), so they're keyed here the same way Dockerfile/
  // Makefile are. Both preview as R.
  rprofile: 'r', renviron: 'r',
  lua: 'lua', pl: 'perl', pm: 'perl',
  erl: 'plaintext', ex: 'elixir', exs: 'elixir',
  hs: 'plaintext', ml: 'plaintext', mli: 'plaintext',
  clj: 'clojure', lisp: 'plaintext', el: 'plaintext',
  dockerfile: 'dockerfile', makefile: 'plaintext', cmake: 'plaintext',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'plaintext', patch: 'plaintext',
  md: 'markdown', txt: 'plaintext', log: 'plaintext', env: 'plaintext',
};

export const binaryExts = new Set([
  // Scientific data
  'rds', 'rda', 'rdata', 'qs2', 'qs', 'h5ad', 'h5', 'hdf5', 'hdf',
  'loom', 'anndata', 'zarr', 'nwb',
  'npy', 'npz', 'mat', 'pkl', 'pickle', 'parquet', 'feather', 'arrow',
  'fst', 'sas7bdat', 'xpt', 'dta', 'sav',
  // Databases
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  // Compiled / binary
  'bin', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'class', 'pyc', 'pyo',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'zst', 'lz4', 'tgz',
  // Media (non-image)
  'mp3', 'mp4', 'wav', 'flac', 'ogg', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Other binary (Office stay binary so they never fall into TextPreview)
  'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm',
  'odt', 'ods', 'odp',
  'epub', 'mobi',
]);

export function previewLoadingMessage(
  retrying: boolean,
  fallback = 'Loading file...',
  progress?: { received: number; total?: number | null } | null,
  slow = false,
): string {
  if (retrying) return 'Connection interrupted, retrying…';
  const bytes = progress && progress.received > 0
    ? formatBytes(progress.received)
    : null;
  if (slow) {
    return bytes
      ? `${fallback} — still loading (${bytes}${progress?.total ? ` / ${formatBytes(progress.total)}` : ''}); the agent may be slow or reconnecting…`
      : `${fallback} — still loading; the agent may be slow or reconnecting…`;
  }
  if (bytes) {
    return progress?.total
      ? `${fallback} (${bytes} / ${formatBytes(progress.total)})`
      : `${fallback} (${bytes})`;
  }
  return fallback;
}

export function gateLoadingMessage(retrying: boolean): string {
  return retrying ? 'Connection interrupted, retrying…' : 'Checking file size...';
}

export function isTextFile(ext: string): boolean {
  if (binaryExts.has(ext)) return false;
  return ext in extToLang;
}

// HTML is the only viewer that renders an <iframe>, and iframes are the
// only content Safari breaks when hidden with visibility:hidden (no repaint
// on re-show → white screen; wheel scrolling stuck). PreviewWorkspace must
// hide those panes OFFScreen instead. This single source of truth keeps the
// dispatch in PreviewPane and the hiding scheme in PreviewWorkspace from
// drifting apart — a mismatch would silently re-trigger the Safari bug.
export function isHtmlPreviewExt(ext: string): boolean {
  return ext === 'html' || ext === 'htm';
}

// ── LoadingOverlay ────────────────────────────────────────────────────────

export function LoadingOverlay({ message, onCancel }: {
  message?: string;
  onCancel?: () => void;
}) {
  return (
    <div style={styles.overlay}>
      <div style={styles.overlayContent}>
        <div style={styles.spinner} />
        <p style={styles.overlayText}>{message || 'Loading...'}</p>
        {onCancel && (
          <button onClick={onCancel} style={styles.overlayCancelBtn}>Cancel</button>
        )}
      </div>
    </div>
  );
}

// ── Large-file gate ──────────────────────────────────────────────────────
// Shared across every text/markdown/html/csv/image preview. Asks the agent
// for the file size up-front via fsStat; if it exceeds the threshold we
// render a warning + "Load anyway" button instead of fetching the body.
// A failed stat is terminal for this load attempt: the viewer renders a local
// error and waits for an explicit retry instead of guessing that the path is
// still usable. This handles files removed after the directory was listed
// without polling or monitoring the directory for changes.

const MEDIA_PREVIEW_CONFIRM_BYTES = 15 * 1024 * 1024;
const TEXT_PREVIEW_CONFIRM_BYTES = 2 * 1024 * 1024;

export const PREVIEW_SIZE_THRESHOLDS = {
  image: MEDIA_PREVIEW_CONFIRM_BYTES,
  pdf: MEDIA_PREVIEW_CONFIRM_BYTES,
  text: TEXT_PREVIEW_CONFIRM_BYTES,
  markdown: TEXT_PREVIEW_CONFIRM_BYTES,
  html: TEXT_PREVIEW_CONFIRM_BYTES,
  csv: TEXT_PREVIEW_CONFIRM_BYTES,
} as const;

export function useFileGate(opts: {
  agentId: string;
  root: string;
  path: string;
  threshold: number;
}) {
  const { agentId, root, path, threshold } = opts;
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [bypassed, setBypassed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const cancelRef = useRef<AbortController | null>(null);
  const mounted = useMounted();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    cancelRef.current = controller;
    setSize(null);
    setError(null);
    setRetrying(false);
    setBypassed(false);
    void (async () => {
      try {
        const data = await retryAsync(
          async () => throwIfAgentError(await fsStat(agentId, root, path, controller.signal)),
          {
            maxAttempts: 3,
            maxDurationMs: 90_000,
            agentId,
            signal: controller.signal,
            onRetry: () => {
              if (!cancelled && mounted.current) setRetrying(true);
            },
          },
        );
        if (cancelled || !mounted.current) return;
        if (!data.stat) {
          setError(fileStatErrorMessage(data.error));
          return;
        }
        setSize(data.stat.size ?? 0);
        setRetrying(false);
      } catch (cause) {
        if (cancelled || !mounted.current) return;
        const err = cause as { name?: string };
        if (err?.name === 'AbortError') return;
        setError(fileStatErrorMessage(cause));
        setRetrying(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (cancelRef.current === controller) cancelRef.current = null;
    };
  }, [agentId, root, path, threshold, retryToken, mounted]);

  const sizeUnknown = size === null && error === null;
  const isLarge = size !== null && size >= threshold;

  return {
    size,
    error,
    retrying,
    sizeUnknown,
    isLarge,
    bypassed,
    cancel: useCallback(() => {
      cancelRef.current?.abort();
      cancelRef.current = null;
      if (mounted.current) {
        setSize(null);
        setRetrying(false);
        setError('Cancelled');
      }
    }, [mounted]),
    forceLoad: useCallback(() => setBypassed(true), []),
    retry: useCallback(() => setRetryToken((token) => token + 1), []),
  };
}

function fileStatErrorMessage(error: unknown): string {
  const value = error as { status?: number; error?: string; message?: string } | string | undefined;
  const code = typeof value === 'string' ? value : value?.error;
  const status = typeof value === 'object' ? value?.status : undefined;
  if (status === 404 || code === 'not_found' || code?.includes('No such file or directory')) {
    return 'The file is no longer available.';
  }
  if (code === 'root_unavailable') return 'This root is no longer available.';
  if (status === 401 || code === 'unauthorized' || code === 'session_expired') {
    return 'Session expired. Please log in again.';
  }
  if (status === 403 || code === 'permission_denied' || code === 'path_denied') {
    return 'The file cannot be accessed.';
  }
  if (code === 'backend_offline') return 'The agent is offline.';
  if (typeof value === 'object' && value?.message) return value.message;
  return 'The file is no longer available or cannot be accessed.';
}

export function FileGateError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={styles.container} role="alert">
      <div style={styles.largeImageWarning}>
        <p style={styles.errorText}>{message}</p>
        <button onClick={onRetry} style={styles.retryBtn}>Retry</button>
      </div>
    </div>
  );
}

export function LargeFileWarning({ size, flavor, onForceLoad, agentId, root, path }: {
  size: number;
  flavor: string;
  onForceLoad: () => void;
  agentId: string;
  root: string;
  path: string;
}) {
  const sizeMB = (size / (1024 * 1024)).toFixed(1);
  return (
    <div style={styles.container}>
      <div style={styles.largeImageWarning}>
        <p style={styles.largeImageTitle}>Large {flavor} ({sizeMB} MB)</p>
        <p style={styles.largeImageText}>Loading may use significant memory or freeze the tab.</p>
        <button onClick={onForceLoad} style={styles.loadImageBtn}>Load anyway</button>
        <FileDownloadLink
          agentId={agentId}
          root={root}
          path={path}
          style={styles.downloadLink}
        >
          Download instead
        </FileDownloadLink>
      </div>
    </div>
  );
}

// ── CopyButton ────────────────────────────────────────────────────────────

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useMounted();

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    if (!mounted.current) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mounted.current) setCopied(false);
    }, 2000);
  }, [text, mounted]);

  return (
    <button onClick={handleClick} style={copied ? styles.toolBtnCopied : styles.toolBtn}>
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────

export const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%', overflow: 'auto', padding: 20,
    background: c.bg, minWidth: 0, position: 'relative',
    fontFamily: font.sans,
  },
  markdownContainer: {
    height: '100%', overflow: 'auto',
    background: c.bg, minWidth: 0,
  },
  markdown: {
    padding: 20, color: c.text, fontSize: 14, lineHeight: 1.7,
    overflowWrap: 'break-word', wordBreak: 'break-word',
    fontFamily: font.sans,
  },
  tableWrap: {
    overflowX: 'auto',
  },
  codeContainer: {
    height: '100%', overflow: 'auto',
    background: c.bg, minWidth: 0,
  },
  monacoContainer: {
    display: 'flex', flexDirection: 'column', height: '100%',
    background: c.bg, minWidth: 0, overflow: 'hidden',
  },
  monacoEditorHost: {
    flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden',
  },
  // Image viewer owns a flex column that fills the preview pane. Without
  // display:flex on the root, imageStage's flex:1 is ignored and tall images
  // overflow/clip instead of fitting (maxHeight:100% needs a definite parent).
  imageViewer: {
    display: 'flex', flexDirection: 'column',
    height: '100%', overflow: 'hidden', padding: 0,
    background: c.bg, minWidth: 0, position: 'relative',
    fontFamily: font.sans,
  },
  image: {
    maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto',
    objectFit: 'contain', display: 'block',
  },
  htmlFrame: { width: '100%', height: '100%', border: 'none', background: c.surface },
  htmlContainer: {
    display: 'flex', flexDirection: 'column', height: '100%',
    background: c.bg, minWidth: 0,
  },
  htmlToolbar: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle, flexShrink: 0,
  },
  toolbarBtn: {
    padding: '4px 10px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 12, lineHeight: 1, transition: 'all 0.15s',
  },
  toolbarPath: {
    flex: 1, textAlign: 'right', color: c.textMuted, fontSize: 11,
    fontFamily: font.mono, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  htmlContent: {
    flex: 1, position: 'relative', overflow: 'hidden',
  },
  sourceCode: {
    margin: 0, padding: 16, height: '100%', overflow: 'auto',
    background: c.surface, color: c.text, fontSize: 13,
    fontFamily: font.mono,
    lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
  code: {
    fontFamily: font.mono,
    fontSize: 13, color: c.text,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5,
    margin: 0, padding: '0 16px',
  },
  codeToolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 12px', gap: 12,
    borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
  },
  metaInfo: {
    color: c.textMuted, fontSize: 11, fontFamily: font.mono,
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  toolBtn: {
    padding: '3px 10px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 11, lineHeight: 1, transition: 'all 0.15s',
  },
  toolBtnCopied: {
    padding: '3px 10px', borderRadius: radius.sm, border: `1px solid ${c.success}`,
    background: c.successBg, color: c.success, cursor: 'default',
    fontSize: 11, lineHeight: 1,
  },
  imageStage: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', position: 'relative', minHeight: 0, width: '100%',
    // Pinch / drag handled via pointer events; avoid browser pan-zoom steal.
    touchAction: 'none',
  },
  imageToolbar: {
    position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 6px', borderRadius: radius.pill,
    background: c.surface, border: `1px solid ${c.border}`,
    boxShadow: shadow.md, zIndex: 10,
  },
  imgToolBtn: {
    padding: '4px 10px', borderRadius: radius.pill, border: 'none',
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 12, lineHeight: 1, minWidth: 28, transition: 'all 0.15s',
  },
  imgZoomLabel: {
    color: c.text, fontSize: 11, fontFamily: font.mono,
    minWidth: 36, textAlign: 'center',
  },
  imgToolDivider: {
    width: 1, height: 14, background: c.border, margin: '0 2px',
  },
  csvTableWrap: {
    flex: 1, overflow: 'auto', background: c.surface,
  },
  csvTable: {
    borderCollapse: 'collapse', width: '100%', fontSize: 12,
    fontFamily: font.mono,
  },
  csvTh: {
    padding: '6px 10px', textAlign: 'left', fontWeight: 600,
    color: c.text, background: c.bgMuted,
    borderBottom: `1px solid ${c.border}`,
    borderRight: `1px solid ${c.borderSubtle}`,
    position: 'sticky', top: 0, zIndex: 1,
    whiteSpace: 'nowrap',
  },
  csvTd: {
    padding: '4px 10px', color: c.textSecondary,
    borderBottom: `1px solid ${c.borderSubtle}`,
    borderRight: `1px solid ${c.borderSubtle}`,
    whiteSpace: 'nowrap', verticalAlign: 'top',
  },
  denied: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', gap: 8,
  },
  deniedTitle: { color: c.warning, fontSize: 16, fontWeight: 600, margin: 0 },
  deniedText: { color: c.textMuted, fontSize: 13, marginTop: 4 },
  download: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', gap: 12,
  },
  largeImageWarning: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', gap: 12,
  },
  largeImageTitle: { color: c.warning, fontSize: 15, fontWeight: 600, margin: 0 },
  largeImageText: { color: c.textMuted, fontSize: 13, margin: 0 },
  loadImageBtn: {
    padding: '8px 24px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 500, transition: 'background 0.15s',
  },
  downloadText: { color: c.textMuted, fontSize: 14 },
  downloadLink: { color: c.accent, fontSize: 13, textDecoration: 'none' },
  loadingText: { color: c.textMuted },
  errorText: { color: c.danger, marginBottom: 8, textAlign: 'center', fontSize: 13 },
  cancelBtn: {
    padding: '4px 12px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 12,
  },
  retryBtn: {
    padding: '6px 16px', borderRadius: radius.md, border: `1px solid ${c.accent}`,
    background: 'transparent', color: c.accent, cursor: 'pointer', fontSize: 13,
    fontWeight: 500, transition: 'all 0.15s',
  },
  // Loading overlay styles
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(255, 255, 255, 0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100, backdropFilter: 'blur(2px)',
  },
  overlayContent: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
  },
  spinner: {
    width: 36, height: 36,
    border: `3px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  overlayText: {
    color: c.textSecondary, fontSize: 13, margin: 0, textAlign: 'center',
  },
  progressBar: {
    width: 200, height: 4, background: c.border,
    borderRadius: radius.pill, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: c.accent, transition: 'width 0.3s ease',
  },
  overlayCancelBtn: {
    padding: '6px 20px', borderRadius: radius.md,
    border: `1px solid ${c.border}`, background: 'transparent',
    color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
};
