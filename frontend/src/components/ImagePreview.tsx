import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useMounted,
  useFileGate,
  FileGateError,
  LargeFileWarning,
  LoadingOverlay,
  PREVIEW_SIZE_THRESHOLDS,
  styles,
} from './previewShared';

// Extracted from PreviewPane so the TIFF decoder (UTIF, ~50KB) can be lazy-
// loaded only when a TIFF is actually opened. Native image formats
// (png/jpg/...) stay on the fast path — no decoder needed, just fetch the
// blob and hand the URL to <img>.

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;

interface Props {
  agentId: string;
  root: string;
  path: string;
  url: string;
  ext: string;
}

// Decode TIFF ArrayBuffer into a PNG blob via UTIF + canvas. UTIF is
// dynamically imported so non-TIFF previews never pay the cost.
async function decodeTiff(buffer: ArrayBuffer): Promise<Blob> {
  const UTIF = (await import('utif')).default;
  const ifds = UTIF.decode(buffer);
  if (!ifds || ifds.length === 0) throw new Error('No image data in TIFF');
  const ifd = ifds[0]; // multi-page TIFF: show first page
  UTIF.decodeImage(buffer, ifd);
  const rgba: Uint8Array = UTIF.toRGBA8(ifd);
  const width: number = ifd.width;
  const height: number = ifd.height;
  if (!width || !height) throw new Error('TIFF has no dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode decoded TIFF'))),
      'image/png',
    );
  });
}

export function ImagePreview({ agentId, root, path, url, ext }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.image });
  const fileSize = gate.size;
  const [objectURL, setObjectURL] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [imgDecoding, setImgDecoding] = useState(false);
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
  const abortRef = useRef<AbortController | null>(null);
  const objectURLRef = useRef<string | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isTiff = ext === 'tiff' || ext === 'tif';

  // Release the current object URL (if any) and clear refs/state.
  const releaseObjectURL = useCallback(() => {
    if (objectURLRef.current) {
      URL.revokeObjectURL(objectURLRef.current);
      objectURLRef.current = null;
    }
    if (mounted.current) {
      setObjectURL(null);
    }
  }, [mounted]);

  const startLoad = useCallback(() => {
    if (!mounted.current) return;

    abortRef.current?.abort();
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    releaseObjectURL();

    setImgLoading(true);
    setImgDecoding(false);
    setSlowLoading(false);
    setImgError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    slowTimerRef.current = setTimeout(() => {
      if (mounted.current && !controller.signal.aborted) {
        setSlowLoading(true);
      }
    }, 8000);

    // TIFF: arrayBuffer → UTIF decode → canvas → PNG blob. Everything else:
    // straight blob (browser decodes natively).
    const blobPromise = isTiff
      ? fetch(url, { credentials: 'include', signal: controller.signal })
          .then(async (r) => {
            if (!r.ok) {
              if (r.status === 413) throw new Error('File exceeds hub-side preview size limit (256MB)');
              if (r.status === 401 || r.status === 403) throw new Error('Authentication required');
              throw new Error(`HTTP ${r.status}`);
            }
            return decodeTiff(await r.arrayBuffer());
          })
      : fetch(url, { credentials: 'include', signal: controller.signal })
          .then((r) => {
            if (!r.ok) {
              if (r.status === 413) throw new Error('File exceeds hub-side preview size limit (256MB)');
              if (r.status === 401 || r.status === 403) throw new Error('Authentication required');
              throw new Error(`HTTP ${r.status}`);
            }
            return r.blob();
          });

    blobPromise
      .then((blob) => {
        if (!mounted.current || controller.signal.aborted) return;
        const objURL = URL.createObjectURL(blob);
        objectURLRef.current = objURL;
        setObjectURL(objURL);
        setImgDecoding(true);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (!mounted.current) return;
        if (slowTimerRef.current) {
          clearTimeout(slowTimerRef.current);
          slowTimerRef.current = null;
        }
        setImgLoading(false);
        setImgDecoding(false);
        setSlowLoading(false);
        setImgError(e?.message || 'Failed to load image');
      });
  }, [mounted, releaseObjectURL, url, isTiff]);

  const cancelLoad = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    releaseObjectURL();
    if (mounted.current) {
      setImgLoading(false);
      setImgDecoding(false);
      setSlowLoading(false);
      setImgError('Cancelled');
    }
  }, [mounted, releaseObjectURL]);

  const handleRetry = useCallback(() => {
    setImgError(null);
    setZoom(1);
    setRotation(0);
    setPos({ x: 0, y: 0 });
    setRetryKey((k) => k + 1);
    startLoad();
  }, [startLoad]);

  // Auto-load once gate allows (size known + not large + not bypassed).
  useEffect(() => {
    if (gate.sizeUnknown || gate.error) return;
    if (gate.isLarge && !gate.bypassed) return;
    startLoad();
  }, [gate.sizeUnknown, gate.error, gate.isLarge, gate.bypassed, startLoad]);

  // Cleanup on unmount: abort in-flight fetch + release object URL.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      if (objectURLRef.current) URL.revokeObjectURL(objectURLRef.current);
      objectURLRef.current = null;
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

  if (gate.sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking image size..." />
      </div>
    );
  }
  if (gate.error) return <FileGateError message={gate.error} onRetry={gate.retry} />;

  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={fileSize!}
        flavor="image"
        onForceLoad={gate.forceLoad}
        url={url}
      />
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
          src={objectURL || undefined}
          alt={path}
          draggable={false}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
          style={{
            ...styles.image,
            display: (imgError || !objectURL) ? 'none' : 'block',
            opacity: imgLoading ? 0 : 1,
            transition: dragging ? 'none' : 'opacity 0.3s ease',
            cursor,
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            transformOrigin: 'center center',
            userSelect: 'none',
          }}
          onLoad={() => {
            if (mounted.current && imgDecoding) {
              if (slowTimerRef.current) {
                clearTimeout(slowTimerRef.current);
                slowTimerRef.current = null;
              }
              setImgLoading(false);
              setImgDecoding(false);
              setSlowLoading(false);
            }
          }}
          onError={() => {
            if (mounted.current && imgDecoding) {
              if (slowTimerRef.current) {
                clearTimeout(slowTimerRef.current);
                slowTimerRef.current = null;
              }
              setImgLoading(false);
              setImgDecoding(false);
              setSlowLoading(false);
              setImgError('Failed to decode image (data may be corrupt)');
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
