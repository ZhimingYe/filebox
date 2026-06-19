import { useState, useEffect, useRef, useCallback } from 'react';
import { c, radius, font, shadow } from '../theme';
import { fsStat } from '../api/client';

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

export function useFetchText(url: string, enabled = true) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);
  const cancelRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      cancelRef.current?.abort();
      cancelRef.current = null;
      setText(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    cancelRef.current = controller;
    setLoading(true);
    setError(null);
    setText(null);
    fetch(url, { credentials: 'include', signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (cancelled) return;
        setText(t);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || e.name === 'AbortError') return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      cancelRef.current = null;
    };
  }, [url, retryToken, enabled]);

  const cancel = useCallback(() => {
    cancelRef.current?.abort();
    cancelRef.current = null;
    setLoading(false);
    setError('Cancelled');
  }, []);

  const retry = useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  return { text, error, loading, cancel, retry };
}

// ── wrap preference ───────────────────────────────────────────────────────
// Module-level mutable so it persists across file switches (PreviewPane
// remounts with a new key when the user picks a different file).

export let wrapPref = true;

export function setWrapPref(v: boolean) {
  wrapPref = v;
}

// ── File-type maps ────────────────────────────────────────────────────────

export const extToLang: Record<string, string> = {
  rs: 'rust', py: 'python',
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', csv: 'csv',
  sql: 'sql', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  r: 'r', R: 'r',
  lua: 'lua', pl: 'perl', pm: 'perl',
  erl: 'erlang', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', lisp: 'lisp', el: 'lisp',
  dockerfile: 'dockerfile', makefile: 'makefile', cmake: 'cmake',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff',
  md: 'markdown', txt: 'text', log: 'text', env: 'text',
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
  // Other binary
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'epub', 'mobi',
]);

export function isTextFile(ext: string): boolean {
  if (binaryExts.has(ext)) return false;
  return ext in extToLang;
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
// Matches the policy ImagePreview already had: if fsStat itself fails
// (network blip, momentary offline), sizeUnknown flips false so we don't
// strand the user on "Checking file size..." forever — the preview
// proceeds and the per-preview slow-load overlay catches genuinely huge
// files.

export const PREVIEW_SIZE_THRESHOLDS = {
  image: 10 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  markdown: 2 * 1024 * 1024,
  html: 2 * 1024 * 1024,
  csv: 5 * 1024 * 1024,
} as const;

export function useFileGate(opts: {
  agentId: string;
  root: string;
  path: string;
  threshold: number;
}) {
  const { agentId, root, path, threshold } = opts;
  const [size, setSize] = useState<number | null>(null);
  const [statError, setStatError] = useState(false);
  const [bypassed, setBypassed] = useState(false);
  const mounted = useMounted();

  useEffect(() => {
    let cancelled = false;
    setSize(null);
    setStatError(false);
    setBypassed(false);
    fsStat(agentId, root, path).then((data) => {
      if (!cancelled && mounted.current && data.stat) {
        setSize(data.stat.size ?? 0);
      }
    }).catch(() => {
      if (!cancelled && mounted.current) setStatError(true);
    });
    return () => { cancelled = true; };
  }, [agentId, root, path, threshold, mounted]);

  const sizeUnknown = size === null && !statError;
  const isLarge = size !== null && size > threshold;

  return {
    size,
    sizeUnknown,
    isLarge,
    bypassed,
    forceLoad: useCallback(() => setBypassed(true), []),
  };
}

export function LargeFileWarning({ size, flavor, onForceLoad, url }: {
  size: number;
  flavor: string;
  onForceLoad: () => void;
  url: string;
}) {
  const sizeMB = (size / (1024 * 1024)).toFixed(1);
  return (
    <div style={styles.container}>
      <div style={styles.largeImageWarning}>
        <p style={styles.largeImageTitle}>Large {flavor} ({sizeMB} MB)</p>
        <p style={styles.largeImageText}>Loading may use significant memory or freeze the tab.</p>
        <button onClick={onForceLoad} style={styles.loadImageBtn}>Load anyway</button>
        <a href={url} download style={styles.downloadLink}>Download instead</a>
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
    maxWidth: 800, overflowWrap: 'break-word', wordBreak: 'break-word',
    fontFamily: font.sans,
  },
  codeContainer: {
    height: '100%', overflow: 'auto',
    background: c.bg, minWidth: 0,
  },
  image: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' },
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
    overflow: 'hidden', position: 'relative', minHeight: 0,
  },
  imageToolbar: {
    position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 6px', borderRadius: radius.pill,
    background: 'rgba(255,255,255,0.95)', border: `1px solid ${c.border}`,
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
