import { useState, useEffect, useRef, useCallback, memo, lazy, Suspense } from 'react';
import { fileRawUrl, fsStat } from '../api/client';
import { c } from '../theme';

import {
  useMounted,
  LoadingOverlay,
  isTextFile,
  styles,
} from './previewShared';

// Heavy preview components are lazy-loaded so their deps only download when
// the user actually opens that file type. The biggest is TextPreview
// (react-syntax-highlighter with all languages ~600KB), followed by
// MarkdownPreview (react-markdown + remark-gfm ~80KB). PdfPreview pulls
// pdfjs-dist (~500KB + 1.2MB worker) only when a PDF is opened.
const PdfPreview = lazy(() => import('./PdfPreview').then(m => ({ default: m.PdfPreview })));
const TextPreview = lazy(() => import('./TextPreview').then(m => ({ default: m.TextPreview })));
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(m => ({ default: m.MarkdownPreview })));
const HtmlPreview = lazy(() => import('./HtmlPreview').then(m => ({ default: m.HtmlPreview })));
const CsvPreview = lazy(() => import('./CsvPreview').then(m => ({ default: m.CsvPreview })));

interface Props {
  agentId: string;
  root: string;
  path: string;
  entryType: string;
  denied: boolean;
}

function SuspenseFallback({ label }: { label: string }) {
  return (
    <div style={styles.container}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: c.textMuted, fontSize: 13,
      }}>
        {label}
      </div>
    </div>
  );
}

// Memoized so dragging the file/preview splitter (which re-renders App and
// would otherwise cascade into a SyntaxHighlighter re-tokenize on every
// animation frame) does not re-render the preview subtree. Props are all
// primitives that only change when the selected file changes.
export const PreviewPane = memo(function PreviewPane({ agentId, root, path, entryType, denied }: Props) {
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
    return (
      <Suspense fallback={<SuspenseFallback label="Loading PDF viewer..." />}>
        <PdfPreview url={url} />
      </Suspense>
    );
  }

  if (['md', 'markdown'].includes(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading markdown viewer..." />}>
        <MarkdownPreview url={url} />
      </Suspense>
    );
  }

  if (['html', 'htm'].includes(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading HTML viewer..." />}>
        <HtmlPreview agentId={agentId} root={root} path={path} url={url} />
      </Suspense>
    );
  }

  if (['csv', 'tsv'].includes(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading CSV viewer..." />}>
        <CsvPreview url={url} ext={ext} path={path} />
      </Suspense>
    );
  }

  if (isTextFile(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading code viewer..." />}>
        <TextPreview url={url} ext={ext} />
      </Suspense>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.download}>
        <p style={styles.downloadText}>No preview available for .{ext} files</p>
        <a href={url} download style={styles.downloadLink}>Download</a>
      </div>
    </div>
  );
});

// ── Image Preview ─────────────────────────────────────────────────────────
//
// Inline (not lazy) because the deps are tiny (no SyntaxHighlighter /
// react-markdown) and image previews are common. Keeping it inline avoids a
// network round-trip on the most frequent preview path.

const LARGE_IMAGE_THRESHOLD = 10 * 1024 * 1024; // 10MB
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;

function ImagePreview({ agentId, root, path, url }: { agentId: string; root: string; path: string; url: string }) {
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [forceLoad, setForceLoad] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);
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
  const sizeUnknown = fileSize === null;

  const startLoad = useCallback(() => {
    if (!mounted.current) return;
    loadingRef.current = true;
    setImgLoading(true);
    setSlowLoading(false);
    setImgError(null);
  }, []);

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
  }, []);

  const handleForceLoad = useCallback(() => {
    setForceLoad(true);
    startLoad();
  }, [startLoad]);

  const handleRetry = useCallback(() => {
    setImgError(null);
    setZoom(1);
    setRotation(0);
    setPos({ x: 0, y: 0 });
    setRetryKey((k) => k + 1);
    startLoad();
  }, [startLoad]);

  useEffect(() => {
    if (!sizeUnknown && !isLarge && !forceLoad) {
      startLoad();
    }
  }, [isLarge, forceLoad, sizeUnknown, startLoad]);

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

  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (imgLoading || imgError) return;
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setZoom((z) => clampZoom(+(z + delta).toFixed(2)));
  }, [imgLoading, imgError]);

  const handleDoubleClick = useCallback(() => {
    if (imgLoading || imgError) return;
    setZoom((z) => (z < 1.5 ? 2.0 : 1.0));
    setPos({ x: 0, y: 0 });
  }, [imgLoading, imgError]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y };
  }, [zoom, pos.x, pos.y]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setPos({
        x: start.posX + (e.clientX - start.x),
        y: start.posY + (e.clientY - start.y),
      });
    };
    const onUp = () => {
      setDragging(false);
      dragStartRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const handleRotate = (dir: 'left' | 'right') => {
    setRotation((r) => (dir === 'left' ? (r - 90 + 360) % 360 : (r + 90) % 360));
  };

  const handleReset = () => {
    setZoom(1);
    setRotation(0);
    setPos({ x: 0, y: 0 });
  };

  if (sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking image size..." />
      </div>
    );
  }

  if (isLarge && !forceLoad) {
    const sizeMB = (fileSize! / (1024 * 1024)).toFixed(1);
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

  const interactive = !imgLoading && !imgError;
  const cursor = !interactive ? 'default' : (dragging ? 'grabbing' : (zoom > 1 ? 'grab' : 'zoom-in'));

  return (
    <div ref={containerRef} style={{ ...styles.container, overflow: 'hidden' }}>
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
            <button onClick={handleRetry} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      )}
      <div style={styles.imageStage}>
        <img
          key={retryKey}
          ref={imgRef}
          src={url}
          alt={path}
          draggable={false}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
          style={{
            ...styles.image,
            display: imgError ? 'none' : 'block',
            opacity: imgLoading ? 0 : 1,
            transition: dragging ? 'none' : 'opacity 0.3s ease',
            cursor,
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            transformOrigin: 'center center',
            userSelect: 'none',
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
      {interactive && (
        <div style={styles.imageToolbar}>
          <button onClick={() => setZoom((z) => clampZoom(+(z - 0.1).toFixed(2)))} style={styles.imgToolBtn} title="Zoom out">&minus;</button>
          <span style={styles.imgZoomLabel}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => clampZoom(+(z + 0.1).toFixed(2)))} style={styles.imgToolBtn} title="Zoom in">+</button>
          <span style={styles.imgToolDivider} />
          <button onClick={() => handleRotate('left')} style={styles.imgToolBtn} title="Rotate left">&#x21ba;</button>
          <button onClick={() => handleRotate('right')} style={styles.imgToolBtn} title="Rotate right">&#x21bb;</button>
          <span style={styles.imgToolDivider} />
          <button onClick={handleReset} style={styles.imgToolBtn} title="Reset view">Reset</button>
        </div>
      )}
    </div>
  );
}
