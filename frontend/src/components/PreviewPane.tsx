import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { fileRawUrl, fsStat } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agentId: string;
  root: string;
  path: string;
  entryType: string;
  denied: boolean;
}

// ── Loading Overlay Component ─────────────────────────────────────────────

function LoadingOverlay({ message, onCancel }: {
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

// ── Mounted guard hook ────────────────────────────────────────────────────

function useMounted() {
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);
  return mountedRef;
}

export function PreviewPane({ agentId, root, path, entryType, denied }: Props) {
  if (denied) {
    return (
      <div style={styles.container}>
        <div style={styles.denied}>
          <p style={styles.deniedTitle}>Access Denied</p>
          <p style={styles.deniedText}>This is a sensitive file and cannot be previewed.</p>
        </div>
      </div>
    );
  }

  if (entryType === 'directory') {
    return (
      <div style={styles.container}>
        <div style={styles.download}>
          <p style={styles.downloadText}>Select a file to preview</p>
        </div>
      </div>
    );
  }

  const url = fileRawUrl(agentId, root, path);
  const ext = path.split('.').pop()?.toLowerCase() || '';

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif'].includes(ext)) {
    return <ImagePreview agentId={agentId} root={root} path={path} url={url} />;
  }

  if (ext === 'pdf') {
    return <PdfPreview url={url} />;
  }

  if (['md', 'markdown'].includes(ext)) {
    return <MarkdownPreview url={url} />;
  }

  if (['html', 'htm'].includes(ext)) {
    return <HtmlPreview agentId={agentId} root={root} path={path} url={url} />;
  }

  if (isTextFile(ext)) {
    return <TextPreview url={url} ext={ext} />;
  }

  return (
    <div style={styles.container}>
      <div style={styles.download}>
        <p style={styles.downloadText}>No preview available for .{ext} files</p>
        <a href={url} download style={styles.downloadLink}>Download</a>
      </div>
    </div>
  );
}

// ── Reusable fetch hook with cancel/retry ────────────────────────────────

function useFetchText(url: string) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useMounted();

  const doFetch = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setText(null);
    fetch(url, { credentials: 'include', signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (mounted.current && !controller.signal.aborted) setText(t);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        if (mounted.current && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
  }, [url, mounted]);

  useEffect(() => {
    doFetch();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [doFetch]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (mounted.current) {
      setLoading(false);
      setError('Cancelled');
    }
  }, [mounted]);

  return { text, error, loading, cancel, retry: doFetch };
}

// ── Image Preview ─────────────────────────────────────────────────────────

const LARGE_IMAGE_THRESHOLD = 10 * 1024 * 1024; // 10MB

function ImagePreview({ agentId, root, path, url }: { agentId: string; root: string; path: string; url: string }) {
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [forceLoad, setForceLoad] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const mounted = useMounted();
  const loadingRef = useRef(false);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fsStat(agentId, root, path).then((data) => {
      if (!cancelled && mounted.current && data.stat) {
        setFileSize(data.stat.size);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, root, path, mounted]);

  const isLarge = fileSize !== null && fileSize > LARGE_IMAGE_THRESHOLD;

  const startLoad = useCallback(() => {
    if (!mounted.current) return;
    loadingRef.current = true;
    setImgLoading(true);
    setSlowLoading(false);
    setImgError(null);
  }, [mounted]);

  // Detect slow loading (after 8 seconds)
  useEffect(() => {
    if (!imgLoading) return;
    slowTimerRef.current = setTimeout(() => {
      if (mounted.current && imgLoading) {
        setSlowLoading(true);
      }
    }, 8000);
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [imgLoading, mounted]);

  const cancelLoad = useCallback(() => {
    loadingRef.current = false;
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    // Reset image element to cancel loading
    if (imgRef.current) {
      imgRef.current.src = '';
      imgRef.current.onload = null;
      imgRef.current.onerror = null;
    }
    if (mounted.current) {
      setImgLoading(false);
      setSlowLoading(false);
      setImgError('Cancelled');
    }
  }, [mounted]);

  const handleForceLoad = useCallback(() => {
    setForceLoad(true);
    startLoad();
  }, [startLoad]);

  // Auto-start loading for non-large images
  useEffect(() => {
    if (!isLarge && !forceLoad && fileSize !== null) {
      startLoad();
    }
  }, [isLarge, forceLoad, fileSize, startLoad]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      loadingRef.current = false;
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      if (imgRef.current) {
        imgRef.current.onload = null;
        imgRef.current.onerror = null;
        imgRef.current.src = '';
      }
    };
  }, []);

  if (isLarge && !forceLoad) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    return (
      <div style={styles.container}>
        <div style={styles.largeImageWarning}>
          <p style={styles.largeImageTitle}>Large image ({sizeMB} MB)</p>
          <p style={styles.largeImageText}>Loading this image may use significant memory.</p>
          <button onClick={handleForceLoad} style={styles.loadImageBtn}>Load image</button>
          <a href={url} download style={styles.downloadLink}>Download instead</a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {imgLoading && (
        <LoadingOverlay
          message={slowLoading
            ? (fileSize ? `Image is large (${(fileSize / (1024 * 1024)).toFixed(1)} MB), still loading...` : 'Image is large, still loading...')
            : (fileSize ? `Loading image (${(fileSize / (1024 * 1024)).toFixed(1)} MB)...` : 'Loading image...')
          }
          onCancel={cancelLoad}
        />
      )}
      {imgError && (
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{imgError}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={() => { setImgError(null); startLoad(); }} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      )}
      <img
        ref={imgRef}
        src={url}
        alt={path}
        style={{
          ...styles.image,
          display: imgError ? 'none' : 'block',
          opacity: imgLoading ? 0 : 1,
          transition: 'opacity 0.3s ease',
        }}
        onLoad={() => {
          if (mounted.current && loadingRef.current) {
            loadingRef.current = false;
            if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
            setImgLoading(false);
            setSlowLoading(false);
          }
        }}
        onError={() => {
          if (mounted.current && loadingRef.current) {
            loadingRef.current = false;
            if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
            setImgLoading(false);
            setSlowLoading(false);
            setImgError('Failed to load image');
          }
        }}
      />
    </div>
  );
}

// ── PDF Preview ───────────────────────────────────────────────────────────

function PdfPreview({ url }: { url: string }) {
  const [loading, setLoading] = useState(true);
  const [slowLoading, setSlowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useMounted();

  // Detect slow loading (after 8 seconds)
  useEffect(() => {
    if (!loading) return;

    slowTimerRef.current = setTimeout(() => {
      if (mounted.current && loading) {
        setSlowLoading(true);
      }
    }, 8000);

    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [loading, mounted]);

  const handleLoad = useCallback(() => {
    if (mounted.current) {
      setLoading(false);
      setSlowLoading(false);
    }
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  }, [mounted]);

  const handleError = useCallback(() => {
    if (mounted.current) {
      setLoading(false);
      setSlowLoading(false);
      setError('Failed to load PDF');
    }
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  }, [mounted]);

  const cancelLoad = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = 'about:blank';
    }
    if (mounted.current) {
      setLoading(false);
      setSlowLoading(false);
      setError('Cancelled');
    }
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  }, [mounted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      if (iframeRef.current) {
        iframeRef.current.onload = null;
        iframeRef.current.onerror = null;
        iframeRef.current.src = 'about:blank';
      }
    };
  }, []);

  return (
    <div style={styles.container}>
      {loading && (
        <LoadingOverlay
          message={slowLoading ? "PDF is large, still loading..." : "Loading PDF..."}
          onCancel={cancelLoad}
        />
      )}
      {error && (
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{error}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={() => { setError(null); setLoading(true); setSlowLoading(false); }} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        sandbox="allow-same-origin"
        style={{ ...styles.pdf, display: error ? 'none' : 'block' }}
        title="PDF Preview"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

// ── HTML Preview ──────────────────────────────────────────────────────────

function HtmlPreview({ agentId, root, path, url }: { agentId: string; root: string; path: string; url: string }) {
  const { text, error, loading, cancel, retry } = useFetchText(url);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Build base URL for resolving relative paths
  const dirPath = path.replace(/\/[^/]*$/, '/');
  const baseUrl = fileRawUrl(agentId, root, dirPath);

  // Create Blob URL for better resource loading
  useEffect(() => {
    if (!text) return;

    const processedHtml = injectBaseTag(text, baseUrl);
    const blob = new Blob([processedHtml], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    blobUrlRef.current = blobUrl;

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [text, baseUrl]);

  const handleIframeLoad = useCallback(() => {
    setIframeLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIframeLoading(false);
  }, []);

  const openInNewWindow = useCallback(() => {
    if (blobUrlRef.current) {
      window.open(blobUrlRef.current, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setIframeLoading(true);
    if (iframeRef.current && blobUrlRef.current) {
      iframeRef.current.src = blobUrlRef.current;
    }
  }, []);

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading HTML..." onCancel={cancel} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.errorText}>{error}</p>
        <button onClick={retry} style={styles.retryBtn}>Retry</button>
      </div>
    );
  }

  return (
    <div style={styles.htmlContainer}>
      {/* Toolbar */}
      <div style={styles.htmlToolbar}>
        <button onClick={handleRefresh} style={styles.toolbarBtn} title="Refresh">
          &#x21bb;
        </button>
        <button onClick={() => setShowSource(!showSource)} style={styles.toolbarBtn} title="View Source">
          {showSource ? 'Preview' : 'Source'}
        </button>
        <button onClick={openInNewWindow} style={styles.toolbarBtn} title="Open in new window">
          &#x2197;
        </button>
        <span style={styles.toolbarPath}>{path}</span>
      </div>

      {/* Content */}
      <div style={styles.htmlContent}>
        {iframeLoading && (
          <LoadingOverlay message="Rendering..." />
        )}
        {showSource ? (
          <pre style={styles.sourceCode}>{text}</pre>
        ) : (
          <iframe
            ref={iframeRef}
            src={blobUrlRef.current || ''}
            sandbox="allow-scripts allow-popups allow-forms"
            style={styles.htmlFrame}
            title="HTML Preview"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        )}
      </div>
    </div>
  );
}

// Inject <base> tag into HTML for relative path resolution
function injectBaseTag(html: string, baseUrl: string): string {
  // If HTML already has a <base> tag, don't inject
  if (/<base\s/i.test(html)) {
    return html;
  }

  // Ensure baseUrl ends with /
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  // Escape for safe interpolation into HTML attribute
  const escapedUrl = normalizedBaseUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  // Try to inject after <head> tag
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertPos = html.indexOf(headMatch[0]) + headMatch[0].length;
    return html.slice(0, insertPos) + `\n<base href="${escapedUrl}">` + html.slice(insertPos);
  }

  // If no <head> tag, try to inject after <html> tag
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const insertPos = html.indexOf(htmlMatch[0]) + htmlMatch[0].length;
    return html.slice(0, insertPos) + `\n<head><base href="${escapedUrl}"></head>` + html.slice(insertPos);
  }

  // If no <html> tag either, prepend base tag
  return `<base href="${escapedUrl}">\n${html}`;
}

// ── Markdown Preview ──────────────────────────────────────────────────────

function MarkdownPreview({ url }: { url: string }) {
  const { text, error, loading, cancel, retry } = useFetchText(url);

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading markdown..." onCancel={cancel} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.errorText}>{error}</p>
        <button onClick={retry} style={styles.retryBtn}>Retry</button>
      </div>
    );
  }

  const displayText = text!.length > 500000 ? text!.slice(0, 500000) + '\n\n---\n*File truncated*' : text!;

  return (
    <div style={styles.markdownContainer}>
      <div className="markdown" style={styles.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── Text/Code Preview ─────────────────────────────────────────────────────

function TextPreview({ url, ext }: { url: string; ext: string }) {
  const { text, error, loading, cancel, retry } = useFetchText(url);
  const [wrap, setWrap] = useState(true);

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading file..." onCancel={cancel} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.errorText}>{error}</p>
        <button onClick={retry} style={styles.retryBtn}>Retry</button>
      </div>
    );
  }

  const isLarge = text!.length > 100000;
  const displayText = isLarge ? text!.slice(0, 100000) + '\n... (truncated)' : text!;
  const lang = extToLang[ext] || 'text';

  if (isLarge) {
    return (
      <div style={styles.codeContainer}>
        <div style={styles.codeToolbar}>
          <button onClick={() => setWrap(!wrap)} style={styles.wrapToggle}>
            {wrap ? 'Wrap: On' : 'Wrap: Off'}
          </button>
        </div>
        <pre style={{
          ...styles.code,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          wordBreak: wrap ? 'break-all' : 'normal',
        }}>{displayText}</pre>
      </div>
    );
  }

  return (
    <div style={styles.codeContainer}>
      <div style={styles.codeToolbar}>
        <button onClick={() => setWrap(!wrap)} style={styles.wrapToggle}>
          {wrap ? 'Wrap: On' : 'Wrap: Off'}
        </button>
      </div>
      <div className={wrap ? 'code-transparent code-wrap' : 'code-transparent'}>
        <SyntaxHighlighter
          language={lang}
          style={oneLight}
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: '16px',
            background: 'transparent',
            fontSize: 13,
            lineHeight: 1.5,
            overflowX: wrap ? 'hidden' : 'auto',
            minWidth: 0,
          }}
        >
          {displayText}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

const extToLang: Record<string, string> = {
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

// Binary formats — never preview, always offer download
const binaryExts = new Set([
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

function isTextFile(ext: string): boolean {
  if (binaryExts.has(ext)) return false;
  return ext in extToLang;
}

const styles: Record<string, React.CSSProperties> = {
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
  pdf: { width: '100%', height: '100%', border: 'none' },
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
    display: 'flex', justifyContent: 'flex-end', padding: '6px 12px',
    borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
  },
  wrapToggle: {
    padding: '3px 10px', borderRadius: radius.sm, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 11, transition: 'all 0.15s',
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
