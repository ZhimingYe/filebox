import { useState, useEffect, useRef, useCallback, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
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
const ZOOM_STEP = 0.1;
// Cap decoded preview raster size so a multi-megapixel photo (or a tiny
// file with huge dimensions) cannot freeze the tab. Animated GIF / SVG are
// left alone — canvas re-encode would destroy animation / vector sharpness.
const MAX_PREVIEW_EDGE = 8192;
const MAX_PREVIEW_PIXELS = 16 * 1024 * 1024;

interface Props {
  agentId: string;
  root: string;
  path: string;
  url: string;
  ext: string;
}

function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
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

function shouldDownscale(ext: string, blob: Blob): boolean {
  if (ext === 'gif' || ext === 'svg') return false;
  const type = (blob.type || '').toLowerCase();
  if (type === 'image/gif' || type === 'image/svg+xml') return false;
  return true;
}

/** Downscale oversized rasters; returns the original blob when under budget. */
async function maybeDownscaleBlob(blob: Blob, ext: string): Promise<Blob> {
  if (!shouldDownscale(ext, blob) || typeof createImageBitmap !== 'function') {
    return blob;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  const { width, height } = bitmap;
  const pixels = width * height;
  const edge = Math.max(width, height);
  if (pixels <= MAX_PREVIEW_PIXELS && edge <= MAX_PREVIEW_EDGE) {
    bitmap.close();
    return blob;
  }
  const scale = Math.min(
    MAX_PREVIEW_EDGE / edge,
    Math.sqrt(MAX_PREVIEW_PIXELS / pixels),
  );
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return blob;
    }
    ctx.drawImage(bitmap, 0, 0, dw, dh);
    bitmap.close();
    const mime = (blob.type || '').toLowerCase().includes('png')
      ? 'image/png'
      : 'image/jpeg';
    const quality = mime === 'image/jpeg' ? 0.92 : undefined;
    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), mime, quality);
    });
    return out ?? blob;
  } catch {
    bitmap.close();
    return blob;
  }
}

function httpErrorMessage(status: number): string {
  if (status === 413) return 'File exceeds hub-side preview size limit (256MB)';
  if (status === 401 || status === 403) return 'Authentication required';
  return `HTTP ${status}`;
}

export function ImagePreview({ agentId, root, path, url, ext }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.image });
  const fileSize = gate.size;
  const [objectURL, setObjectURL] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);
  // Pinch state: two-finger zoom on touch devices.
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    startPos: { x: number; y: number };
    midX: number;
    midY: number;
  } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const mounted = useMounted();
  const abortRef = useRef<AbortController | null>(null);
  const objectURLRef = useRef<string | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs so onLoad/onError always see the latest in-flight decode flag
  // without depending on a render-closure that can go stale across retries.
  const decodingRef = useRef(false);
  const zoomRef = useRef(1);
  const posRef = useRef({ x: 0, y: 0 });

  const isTiff = ext === 'tiff' || ext === 'tif';

  const releaseObjectURL = useCallback(() => {
    if (objectURLRef.current) {
      URL.revokeObjectURL(objectURLRef.current);
      objectURLRef.current = null;
    }
    if (mounted.current) {
      setObjectURL(null);
    }
  }, [mounted]);

  const clearSlowTimer = useCallback(() => {
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
  }, []);

  const finishDecodeOk = useCallback(() => {
    if (!mounted.current || !decodingRef.current) return;
    decodingRef.current = false;
    clearSlowTimer();
    setImgLoading(false);
    setSlowLoading(false);
  }, [mounted, clearSlowTimer]);

  const finishDecodeErr = useCallback((message: string) => {
    if (!mounted.current || !decodingRef.current) return;
    decodingRef.current = false;
    clearSlowTimer();
    setImgLoading(false);
    setSlowLoading(false);
    setImgError(message);
  }, [mounted, clearSlowTimer]);

  const startLoad = useCallback(() => {
    if (!mounted.current) return;

    abortRef.current?.abort();
    clearSlowTimer();
    releaseObjectURL();
    decodingRef.current = false;

    setImgLoading(true);
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
    // straight blob (browser decodes natively), then optional dimension cap.
    const blobPromise = (isTiff
      ? fetch(url, { credentials: 'include', signal: controller.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error(httpErrorMessage(r.status));
            return decodeTiff(await r.arrayBuffer());
          })
      : fetch(url, { credentials: 'include', signal: controller.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error(httpErrorMessage(r.status));
            return r.blob();
          })
    ).then((blob) => maybeDownscaleBlob(blob, isTiff ? 'png' : ext));

    blobPromise
      .then((blob) => {
        if (!mounted.current || controller.signal.aborted) return;
        const objURL = URL.createObjectURL(blob);
        objectURLRef.current = objURL;
        decodingRef.current = true;
        setObjectURL(objURL);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (!mounted.current) return;
        decodingRef.current = false;
        clearSlowTimer();
        setImgLoading(false);
        setSlowLoading(false);
        setImgError(e?.message || 'Failed to load image');
      });
  }, [mounted, releaseObjectURL, clearSlowTimer, url, isTiff, ext]);

  const cancelLoad = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    decodingRef.current = false;
    clearSlowTimer();
    releaseObjectURL();
    if (mounted.current) {
      setImgLoading(false);
      setSlowLoading(false);
      setImgError('Cancelled');
    }
  }, [mounted, releaseObjectURL, clearSlowTimer]);

  const resetView = useCallback(() => {
    zoomRef.current = 1;
    posRef.current = { x: 0, y: 0 };
    setZoom(1);
    setRotation(0);
    setPos({ x: 0, y: 0 });
  }, []);

  const handleRetry = useCallback(() => {
    setImgError(null);
    resetView();
    setRetryKey((k) => k + 1);
    startLoad();
  }, [startLoad, resetView]);

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
      clearSlowTimer();
      if (objectURLRef.current) URL.revokeObjectURL(objectURLRef.current);
      objectURLRef.current = null;
      decodingRef.current = false;
    };
  }, [clearSlowTimer]);

  const applyZoomAt = useCallback((nextZoom: number, clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const z0 = zoomRef.current;
    const z1 = clampZoom(+nextZoom.toFixed(2));
    if (z1 === z0) return;
    if (z1 <= 1) {
      zoomRef.current = z1;
      posRef.current = { x: 0, y: 0 };
      setZoom(z1);
      setPos({ x: 0, y: 0 });
      return;
    }
    if (!stage) {
      zoomRef.current = z1;
      setZoom(z1);
      return;
    }
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    const { x, y } = posRef.current;
    // Keep the stage point under the cursor stable across the zoom change.
    const ratio = z1 / z0;
    const nextPos = {
      x: cx - (cx - x) * ratio,
      y: cy - (cy - y) * ratio,
    };
    zoomRef.current = z1;
    posRef.current = nextPos;
    setZoom(z1);
    setPos(nextPos);
  }, []);

  // Non-passive wheel on the stage so we can preventDefault (stop the
  // preview pane / page from scrolling while zooming). React's onWheel is
  // passive in modern browsers and cannot cancel the scroll.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (imgLoading || imgError) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      applyZoomAt(zoomRef.current + delta, e.clientX, e.clientY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [imgLoading, imgError, applyZoomAt]);

  const handleDoubleClick = useCallback((e: MouseEvent) => {
    if (imgLoading || imgError) return;
    const next = zoomRef.current < 1.5 ? 2.0 : 1.0;
    if (next <= 1) {
      zoomRef.current = 1;
      posRef.current = { x: 0, y: 0 };
      setZoom(1);
      setPos({ x: 0, y: 0 });
      return;
    }
    applyZoomAt(next, e.clientX, e.clientY);
  }, [imgLoading, imgError, applyZoomAt]);

  const endDrag = useCallback(() => {
    setDragging(false);
    dragStartRef.current = null;
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (imgLoading || imgError) return;
    const stage = stageRef.current;
    if (!stage) return;

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy) || 1;
      const rect = stage.getBoundingClientRect();
      pinchRef.current = {
        startDist: dist,
        startZoom: zoomRef.current,
        startPos: { ...posRef.current },
        midX: (pts[0].x + pts[1].x) / 2 - rect.left - rect.width / 2,
        midY: (pts[0].y + pts[1].y) / 2 - rect.top - rect.height / 2,
      };
      dragStartRef.current = null;
      setDragging(false);
      return;
    }

    // Single-finger / mouse pan only when zoomed in.
    if (zoomRef.current <= 1) return;
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: posRef.current.x,
      posY: posRef.current.y,
    };
  }, [imgLoading, imgError]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy) || 1;
      const pinch = pinchRef.current;
      const next = clampZoom(+(pinch.startZoom * (dist / pinch.startDist)).toFixed(2));
      if (next <= 1) {
        zoomRef.current = next;
        posRef.current = { x: 0, y: 0 };
        setZoom(next);
        setPos({ x: 0, y: 0 });
        return;
      }
      const ratio = next / pinch.startZoom;
      const nextPos = {
        x: pinch.midX - (pinch.midX - pinch.startPos.x) * ratio,
        y: pinch.midY - (pinch.midY - pinch.startPos.y) * ratio,
      };
      zoomRef.current = next;
      posRef.current = nextPos;
      setZoom(next);
      setPos(nextPos);
      return;
    }

    const start = dragStartRef.current;
    if (!start || zoomRef.current <= 1) return;
    const nextPos = {
      x: start.posX + (e.clientX - start.x),
      y: start.posY + (e.clientY - start.y),
    };
    posRef.current = nextPos;
    setPos(nextPos);
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) endDrag();
    // If one finger remains after a pinch, re-arm pan from current pos.
    if (pointersRef.current.size === 1 && zoomRef.current > 1) {
      const remaining = [...pointersRef.current.values()][0];
      setDragging(true);
      dragStartRef.current = {
        x: remaining.x,
        y: remaining.y,
        posX: posRef.current.x,
        posY: posRef.current.y,
      };
    }
  }, [endDrag]);

  const handleRotate = (dir: 'left' | 'right') => {
    setRotation((r) => (dir === 'left' ? (r - 90 + 360) % 360 : (r + 90) % 360));
  };

  const bumpZoom = (delta: number) => {
    const stage = stageRef.current;
    if (!stage) {
      const z1 = clampZoom(+(zoomRef.current + delta).toFixed(2));
      zoomRef.current = z1;
      setZoom(z1);
      if (z1 <= 1) {
        posRef.current = { x: 0, y: 0 };
        setPos({ x: 0, y: 0 });
      }
      return;
    }
    const rect = stage.getBoundingClientRect();
    applyZoomAt(
      zoomRef.current + delta,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  };

  if (gate.sizeUnknown) {
    return (
      <div style={styles.imageViewer}>
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
  const canPan = interactive && zoom > 1;
  const cursor = !interactive
    ? 'default'
    : (dragging ? 'grabbing' : (canPan ? 'grab' : 'zoom-in'));

  return (
    <div style={styles.imageViewer}>
      {imgLoading && (
        <LoadingOverlay
          message={slowLoading
            ? (fileSize ? `Image is large (${(fileSize / (1024 * 1024)).toFixed(1)} MB), still loading...` : 'Image is large, still loading...')
            : (fileSize ? `Loading image (${(fileSize / (1024 * 1024)).toFixed(1)} MB)...` : 'Loading image...')
          }
          onCancel={cancelLoad}
        />
      )}
      {imgError ? (
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{imgError}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={handleRetry} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={stageRef}
            style={{ ...styles.imageStage, cursor }}
            onDoubleClick={handleDoubleClick}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              key={retryKey}
              src={objectURL || undefined}
              alt={path}
              draggable={false}
              style={{
                ...styles.image,
                display: !objectURL ? 'none' : 'block',
                opacity: imgLoading ? 0 : 1,
                transition: dragging ? 'none' : 'opacity 0.3s ease',
                transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                userSelect: 'none',
                pointerEvents: 'none',
              }}
              onLoad={finishDecodeOk}
              onError={() => finishDecodeErr('Failed to decode image (data may be corrupt)')}
            />
          </div>
          {interactive && (
            <div style={styles.imageToolbar}>
              <button onClick={() => bumpZoom(-ZOOM_STEP)} style={styles.imgToolBtn} title="Zoom out">&minus;</button>
              <span style={styles.imgZoomLabel}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => bumpZoom(ZOOM_STEP)} style={styles.imgToolBtn} title="Zoom in">+</button>
              <span style={styles.imgToolDivider} />
              <button onClick={() => handleRotate('left')} style={styles.imgToolBtn} title="Rotate left">&#x21ba;</button>
              <button onClick={() => handleRotate('right')} style={styles.imgToolBtn} title="Rotate right">&#x21bb;</button>
              <span style={styles.imgToolDivider} />
              <button onClick={resetView} style={styles.imgToolBtn} title="Reset view">Reset</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
