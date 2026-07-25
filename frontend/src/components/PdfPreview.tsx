import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { friendlyMessage, mintFileRawAccess } from '../api/client';
import { c, radius, shadow, font } from '../theme';
import { FileDownloadLink } from './FileDownloadLink';
import {
  LoadingOverlay,
  LargeFileWarning,
  useFileGate,
  FileGateError,
  PREVIEW_SIZE_THRESHOLDS,
} from './previewShared';

// Vite bundles the worker with the app via new URL(...). Avoids CDN dep
// and keeps the install offline-capable.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface Props {
  agentId: string;
  root: string;
  path: string;
  url: string;
  skipSizeGate?: boolean;
  downloadPath?: string;
  onRetry?: () => void;
}

// Browser-native PDF viewers (via <iframe>) don't exist on iOS Safari and
// are flaky on some Android browsers — the iframe comes up blank. PDF.js
// renders to <canvas> so it works on every browser, at the cost of pulling
// in pdfjs-dist (~500KB) which we lazy-load via React.lazy at the call site.
//
// Virtualization: only pages within viewport + a 300%-screen buffer get a
// real <Page> mounted. Everything else stays as a placeholder <div> with an
// estimated or cached height. Without this, a 500-page PDF materializes
// 500 canvases at once and OOMs the tab.

const ESTIMATED_ASPECT = 1.414; // A4 portrait, common default before we know real height
/** Typical PDF page width in points — used for placeholders in scale mode. */
const NOMINAL_PAGE_WIDTH_PT = 612;

const PDF_ZOOM_PREF_KEY = 'filebox.pdfZoom';

/** Fit container width, or an absolute pdf.js scale (1 = 100%). */
type PdfZoomMode = 'fit' | number;

const PDF_ZOOM_OPTIONS: { value: PdfZoomMode; label: string }[] = [
  { value: 'fit', label: 'Adaptive' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' },
  { value: 1.25, label: '125%' },
  { value: 1.5, label: '150%' },
  { value: 2, label: '200%' },
];

function readPdfZoomPref(): PdfZoomMode {
  try {
    const raw = sessionStorage.getItem(PDF_ZOOM_PREF_KEY);
    if (raw === 'fit' || raw === null) return 'fit';
    const n = Number(raw);
    if (PDF_ZOOM_OPTIONS.some((o) => o.value === n)) return n;
  } catch {
    /* ignore */
  }
  return 'fit';
}

function writePdfZoomPref(mode: PdfZoomMode) {
  try {
    sessionStorage.setItem(PDF_ZOOM_PREF_KEY, String(mode));
  } catch {
    /* ignore */
  }
}

/** pdf.js surfaces HTTP auth failures as "Unexpected server response (403)" etc. */
function isPdfAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  // Match status codes / known hub errors only — NOT bare "Unexpected server
  // response", which also fires for 5xx and would remint-loop on agent outages.
  return (
    /\b(401|403)\b/.test(m)
    || m.includes('access_token_invalid')
    || m.includes('csrf_denied')
  );
}

export function PdfPreview({
  agentId,
  root,
  path,
  url: _url,
  skipSizeGate = false,
  downloadPath = path,
  onRetry,
}: Props) {
  // Same large-file gate every other preview uses: ask the agent for the file
  // size up-front via fsStat, and if it exceeds the threshold render a
  // "Load anyway?" warning instead of handing the URL straight to react-pdf.
  // Without this a multi-hundred-MB PDF parses into memory and freezes the
  // tab with no recourse (the viewer has its own slow-load overlay, but that
  // can't undo the parse once started).
  const gate = useFileGate({
    agentId,
    root,
    path,
    threshold: skipSizeGate ? Number.MAX_SAFE_INTEGER : PREVIEW_SIZE_THRESHOLDS.pdf,
  });
  // Hoisted above all effects: several of them (slow-load timer, and the
  // render guard below) depend on it. Declaring it lower would hit the
  // temporal dead zone when the effect dependency arrays evaluate at render.
  const mayLoad = !gate.sizeUnknown && !gate.error && !(gate.isLarge && !gate.bypassed);
  // pdf.js cannot send X-CSRF-Token; use a short-lived access_token URL instead.
  // mintNonce bumps to remint after a single auth failure.
  const [accessUrl, setAccessUrl] = useState<string | null>(null);
  const [mintNonce, setMintNonce] = useState(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  // At most one automatic remint until the next successful Document load (or
  // a new file). Must NOT reset on every mintNonce bump — that caused an
  // unbounded remint loop when the server kept returning 403.
  const authRemintUsed = useRef(false);

  useEffect(() => {
    authRemintUsed.current = false;
  }, [agentId, root, path]);

  useEffect(() => {
    if (!mayLoad) {
      setAccessUrl(null);
      return;
    }
    const controller = new AbortController();
    setError(null);
    setAccessUrl(null);
    mintFileRawAccess(agentId, root, path, controller.signal)
      .then(({ url }) => {
        if (!controller.signal.aborted) setAccessUrl(url);
      })
      .catch((err: { name?: string; message?: string; error?: string }) => {
        if (!controller.signal.aborted && err?.name !== 'AbortError') {
          setError(friendlyMessage(err));
        }
      });
    return () => controller.abort();
  }, [mayLoad, agentId, root, path, mintNonce]);

  const remintAfterAuthFailure = useCallback((message: string): boolean => {
    if (!isPdfAuthFailure(message) || authRemintUsed.current) return false;
    authRemintUsed.current = true;
    setError(null);
    setNumPages(0);
    setMintNonce((n) => n + 1);
    return true;
  }, []);
  // Store per-page aspect ratio (height / width) instead of absolute height
  // so placeholders stay correct when the container resizes (pageWidth
  // changes) — no need to invalidate the cache on resize.
  const [pageAspects, setPageAspects] = useState<Record<number, number>>({});
  // Intrinsic page widths (PDF user units) for accurate scale-mode placeholders.
  const [pageBaseWidths, setPageBaseWidths] = useState<Record<number, number>>({});
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>(() => readPdfZoomPref());
  const numPagesRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const placeholderRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const setZoom = useCallback((mode: PdfZoomMode) => {
    setZoomMode(mode);
    writePdfZoomPref(mode);
    // Multi-page: while placeholders resize, IntersectionObserver can briefly
    // mark dozens of pages visible. Keep only a small window around the
    // current anchor so zoom does not mount every canvas at once.
    setVisiblePages((prev) => {
      const n = numPagesRef.current;
      const anchor = prev.size > 0 ? Math.min(...prev) : 1;
      const next = new Set<number>();
      for (let p = anchor; p <= Math.min(n || anchor + 1, anchor + 2); p++) {
        if (p >= 1) next.add(p);
      }
      return next.size > 0 ? next : new Set([1]);
    });
  }, []);

  // Responsive page width: measure the *scroll* pane (not the zoom dock).
  // Coalesce to one update per frame and ignore sub-pixel noise so a parent
  // width change (sidebar toggle, splitter) can't storm page reflows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setContainerWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, []);

  // Slow-load detection: 8s timer, started only once the gate clears us to
  // actually load (mayLoad). Without the mayLoad guard the timer would run
  // while the user is still staring at the LargeFileWarning, expire, and flip
  // slowLoad=true — so when they finally click "Load anyway" the overlay
  // would wrongly say "still loading..." even though the fetch just started.
  useEffect(() => {
    if (!mayLoad) return;
    if (numPages > 0) {
      setSlowLoad(false);
      return;
    }
    const t = setTimeout(() => setSlowLoad(true), 8000);
    return () => clearTimeout(t);
  }, [numPages, mayLoad]);

  // Fit-width (Adaptive): leave a little padding. Scale modes use pdf.js
  // `scale` (1 = 100%) so 100% is true document size, not "100% of pane".
  const fitWidth = containerWidth > 0 ? Math.max(200, containerWidth - 24) : undefined;
  const layoutReady = zoomMode === 'fit' ? fitWidth != null : true;
  const layoutKey = zoomMode === 'fit' ? `fit:${fitWidth ?? 0}` : `scale:${zoomMode}`;

  // Virtualization: track which page placeholders are inside the viewport
  // (plus a generous rootMargin buffer) and only mount real <Page> for those.
  // Depends on numPages + layout — the first paint after onLoadSuccess may
  // still have fitWidth unset (ResizeObserver is async), so we (re)observe
  // once layout settles and placeholders actually mount.
  useEffect(() => {
    if (numPages === 0 || !layoutReady) return;
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const pageNum = Number((entry.target as HTMLElement).dataset.pageNum);
            if (!pageNum) continue;
            if (entry.isIntersecting) {
              if (!next.has(pageNum)) {
                next.add(pageNum);
                changed = true;
              }
            } else {
              if (next.has(pageNum)) {
                next.delete(pageNum);
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      },
      {
        root: container,
        // Viewport + 3 screens of buffer above and below — keeps pages
        // mounted briefly after they scroll out so a quick scroll-back
        // doesn't re-render. Root is the scroll pane only (zoom dock excluded).
        rootMargin: '300% 0px',
        threshold: 0,
      },
    );

    placeholderRefs.current.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [numPages, layoutReady, layoutKey]);

  const onLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    numPagesRef.current = n;
    setNumPages(n);
    setError(null);
    // Successful load restores the one-shot remint budget so a later mid-
    // scroll token expiry can recover once without looping forever.
    authRemintUsed.current = false;
    // First page always rendered initially (covers the "open at top" case).
    // The observer will add more as the user scrolls.
    setVisiblePages(new Set([1]));
    setPageAspects({});
    setPageBaseWidths({});
  };

  const onLoadError = (err: Error) => {
    const message = err.message || 'Failed to load PDF';
    if (remintAfterAuthFailure(message)) return;
    setError('Could not load this PDF. The file may be damaged or temporarily unavailable.');
    numPagesRef.current = 0;
    setNumPages(0);
  };

  const onPageLoadSuccess = (page: {
    pageNumber: number;
    width: number;
    height: number;
    originalWidth?: number;
    originalHeight?: number;
  }) => {
    if (!page.width) return;
    const aspect = page.height / page.width;
    const baseWidth = page.originalWidth && page.originalWidth > 0
      ? page.originalWidth
      : NOMINAL_PAGE_WIDTH_PT;
    setPageAspects((prev) => (
      prev[page.pageNumber] === aspect ? prev : { ...prev, [page.pageNumber]: aspect }
    ));
    setPageBaseWidths((prev) => {
      const rounded = Math.round(baseWidth * 10) / 10;
      if (prev[page.pageNumber] === rounded) return prev;
      return { ...prev, [page.pageNumber]: rounded };
    });
  };

  const onPageLoadError = (err: Error) => {
    const message = err.message || '';
    if (remintAfterAuthFailure(message)) return;
    setError('Could not load this PDF page. The file may be damaged or temporarily unavailable.');
  };

  const retryLoad = useCallback(() => {
    setError(null);
    numPagesRef.current = 0;
    setNumPages(0);
    setAccessUrl(null);
    authRemintUsed.current = false;
    setMintNonce((n) => n + 1);
  }, []);

  // Document is mounted only when mayLoad (declared above the effects) is
  // true: either the file is under threshold, or the user clicked "Load
  // anyway". Mounting it earlier would make react-pdf start fetching/parsing
  // immediately, which is exactly what the gate exists to prevent.

  const widestLayout = useMemo(() => {
    if (zoomMode === 'fit') return fitWidth ?? 0;
    let maxBase = NOMINAL_PAGE_WIDTH_PT;
    for (const w of Object.values(pageBaseWidths)) {
      if (w > maxBase) maxBase = w;
    }
    return maxBase * zoomMode;
  }, [zoomMode, fitWidth, pageBaseWidths]);

  const wideOverflow = zoomMode !== 'fit' && containerWidth > 0 && widestLayout > containerWidth - 8;

  return (
    // Shell owns the zoom dock; only the inner pane scrolls — so the toolbar
    // never rides along with page content at 150%/200%.
    <div style={styles.shell}>
      <div ref={scrollRef} style={styles.scroll}>
        {gate.sizeUnknown && (
          <LoadingOverlay message="Checking PDF size..." />
        )}

        {gate.error && (
          <FileGateError message={gate.error} onRetry={onRetry || gate.retry} />
        )}

        {gate.isLarge && !gate.bypassed && (
          <LargeFileWarning
            size={gate.size!}
            flavor="PDF"
            onForceLoad={gate.forceLoad}
            agentId={agentId}
            root={root}
            path={path}
          />
        )}

        {mayLoad && !error && (!accessUrl || numPages === 0) && (
          <LoadingOverlay
            message={
              !accessUrl
                ? 'Authorizing PDF...'
                : slowLoad
                  ? 'PDF is large, still loading...'
                  : 'Loading PDF...'
            }
          />
        )}

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>
              {isPdfAuthFailure(error)
                ? 'PDF authorization expired. Please retry.'
                : error}
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={onRetry || retryLoad} style={styles.retryBtn}>
                Retry
              </button>
              <FileDownloadLink
                agentId={agentId}
                root={root}
                path={downloadPath}
                style={styles.downloadLink}
              />
            </div>
          </div>
        )}

        {mayLoad && accessUrl && !error && (
          <Document
            key={accessUrl}
            file={accessUrl}
            onLoadSuccess={onLoadSuccess}
            onLoadError={onLoadError}
            loading=""
            error=""
          >
            <div
              style={{
                ...styles.pagesColumn,
                alignItems: wideOverflow ? 'flex-start' : 'center',
                width: wideOverflow ? 'max-content' : '100%',
                minWidth: '100%',
              }}
            >
              {numPages > 0 && layoutReady && Array.from({ length: numPages }, (_, i) => {
                const pageNum = i + 1;
                const isVisible = visiblePages.has(pageNum);
                // Placeholder keeps its slot in the document flow with either the
                // real aspect (cached after first render) or an A4 estimate, so
                // the scrollbar stays stable while pages mount/unmount — critical
                // for multi-page PDFs under virtualization + zoom changes.
                const aspect = pageAspects[pageNum] ?? ESTIMATED_ASPECT;
                const slotWidth = zoomMode === 'fit'
                  ? fitWidth!
                  : (pageBaseWidths[pageNum] ?? NOMINAL_PAGE_WIDTH_PT) * zoomMode;
                const placeholderHeight = aspect * slotWidth;
                return (
                  <div
                    key={pageNum}
                    data-page-num={pageNum}
                    ref={(el) => {
                      if (el) placeholderRefs.current.set(pageNum, el);
                      else placeholderRefs.current.delete(pageNum);
                    }}
                    style={{
                      ...styles.pageWrap,
                      // Keep the slot at least placeholderHeight tall while the real
                      // <Page> canvas loads. Without this the wrap collapses to the
                      // spinner's ~20px height, which shifts total document height,
                      // toggles the container scrollbar, and — because the
                      // ResizeObserver feeds that width back into fitWidth — kicks
                      // off a self-sustaining flicker/jump loop (see scrollbarGutter
                      // note below).
                      height: isVisible ? 'auto' : placeholderHeight,
                      minHeight: placeholderHeight,
                    }}
                  >
                    {isVisible ? (
                      <Page
                        // Key includes layout so canvas rebuilds at the new size
                        // without remounting every virtualized placeholder slot.
                        key={layoutKey}
                        pageNumber={pageNum}
                        {...(zoomMode === 'fit'
                          ? { width: fitWidth }
                          : { scale: zoomMode })}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        loading={<PageSpinner />}
                        onLoadSuccess={onPageLoadSuccess}
                        onLoadError={onPageLoadError}
                      />
                    ) : (
                      // Placeholder: a centered spinner tells the user the page is
                      // queued for render, not that the page is blank. Without this
                      // cue, virtualized pages look like missing content.
                      <div style={{ ...styles.placeholderInner, minHeight: placeholderHeight }}>
                        <PageSpinner />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Document>
        )}
      </div>

      {numPages > 0 && (
        <div style={styles.zoomBar} role="toolbar" aria-label="PDF zoom">
          <div style={styles.zoomChips}>
            {PDF_ZOOM_OPTIONS.map((opt) => {
              const active = opt.value === zoomMode;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setZoom(opt.value)}
                  style={{
                    ...styles.zoomChip,
                    ...(active ? styles.zoomChipActive : null),
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    height: '100%',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.bgSubtle,
    fontFamily: font.sans,
    position: 'relative',
    overflow: 'hidden',
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: 'auto',
    position: 'relative',
    // Reserve a stable gutter for the scrollbar even when content doesn't
    // overflow. The ResizeObserver feeds contentRect.width back into
    // fitWidth, so without this, the scrollbar appearing/disappearing as
    // pages mount/unmount changes the available width a few pixels each way,
    // which re-renders every page, which shifts total height, which toggles
    // the scrollbar again — a self-sustaining flicker/jump loop even with no
    // user interaction. `stable` keeps the gutter constant so the width is
    // invariant to overflow state, breaking the feedback loop.
    scrollbarGutter: 'stable',
  },
  pagesColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 12,
    boxSizing: 'border-box',
  },
  pageWrap: {
    background: c.surface, borderRadius: radius.md,
    boxShadow: shadow.sm, overflow: 'hidden',
  },
  // Centered spinner container used inside the placeholder <div> for pages
  // that haven't mounted yet. The spinner signals "queued for render"
  // rather than "blank page" so virtualization doesn't look like missing
  // content.
  placeholderInner: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%',
  },
  placeholderSpinner: {
    width: 20, height: 20,
    border: `2px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  errorBox: {
    background: c.dangerBg, border: `1px solid ${c.danger}20`,
    borderRadius: radius.md, padding: '14px 18px',
    marginBottom: 12, color: c.danger, fontSize: 13,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
    width: '100%', maxWidth: 480,
  },
  errorText: { margin: 0 },
  retryBtn: {
    padding: '6px 16px', borderRadius: radius.md,
    border: `1px solid ${c.accent}`, background: 'transparent',
    color: c.accent, cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  downloadLink: {
    padding: '6px 16px', borderRadius: radius.md,
    border: `1px solid ${c.danger}`, color: c.danger,
    textDecoration: 'none', fontSize: 13,
  },
  // Docked footer of the shell — not inside the scroll pane, so it cannot
  // slide away with tall/wide page content.
  zoomBar: {
    flexShrink: 0,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    padding: '8px 10px',
    boxSizing: 'border-box',
    borderTop: `1px solid ${c.border}`,
    background: c.bgSubtle,
    zIndex: 20,
  },
  zoomChips: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    borderRadius: radius.pill,
    background: c.surface,
    border: `1px solid ${c.border}`,
    boxShadow: shadow.sm,
    maxWidth: '100%',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  zoomChip: {
    flex: '0 0 auto',
    padding: '6px 10px',
    borderRadius: radius.pill,
    border: 'none',
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1.2,
    fontFamily: font.sans,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    minHeight: 32,
    transition: 'background 0.12s, color 0.12s',
  },
  zoomChipActive: {
    background: c.accentBg,
    color: c.accent,
  },
};

function PageSpinner() {
  return <div style={styles.placeholderSpinner} />;
}
