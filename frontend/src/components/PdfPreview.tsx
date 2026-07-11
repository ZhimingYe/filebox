import { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { c, radius, shadow, font } from '../theme';
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

export function PdfPreview({ agentId, root, path, url }: Props) {
  // Same large-file gate every other preview uses: ask the agent for the file
  // size up-front via fsStat, and if it exceeds the threshold render a
  // "Load anyway?" warning instead of handing the URL straight to react-pdf.
  // Without this a multi-hundred-MB PDF parses into memory and freezes the
  // tab with no recourse (the viewer has its own slow-load overlay, but that
  // can't undo the parse once started).
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.pdf });
  // Hoisted above all effects: several of them (slow-load timer, and the
  // render guard below) depend on it. Declaring it lower would hit the
  // temporal dead zone when the effect dependency arrays evaluate at render.
  const mayLoad = !gate.sizeUnknown && !gate.error && !(gate.isLarge && !gate.bypassed);
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  // Store per-page aspect ratio (height / width) instead of absolute height
  // so placeholders stay correct when the container resizes (pageWidth
  // changes) — no need to invalidate the cache on resize.
  const [pageAspects, setPageAspects] = useState<Record<number, number>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const placeholderRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Responsive page width: pages fit container width minus padding.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
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

  // pageWidth: leave a little padding; pdf.js v6 requires an explicit pixel width.
  // Computed before the virtualization effect so the effect can depend on it.
  const pageWidth = containerWidth > 0 ? Math.max(200, containerWidth - 24) : undefined;

  // Virtualization: track which page placeholders are inside the viewport
  // (plus a generous rootMargin buffer) and only mount real <Page> for those.
  // Depends on both numPages and pageWidth — the first paint after
  // onLoadSuccess may still have pageWidth === 0 (ResizeObserver is async),
  // so we (re)observe once pageWidth settles and placeholders actually mount.
  useEffect(() => {
    if (numPages === 0 || !pageWidth) return;
    const container = containerRef.current;
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
        // doesn't re-render.
        rootMargin: '300% 0px',
        threshold: 0,
      },
    );

    placeholderRefs.current.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [numPages, pageWidth]);

  const onLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setError(null);
    // First page always rendered initially (covers the "open at top" case).
    // The observer will add more as the user scrolls.
    setVisiblePages(new Set([1]));
    setPageAspects({});
  };

  const onLoadError = (err: Error) => {
    setError(err.message || 'Failed to load PDF');
    setNumPages(0);
  };

  const onPageLoadSuccess = (page: { pageNumber: number; width: number; height: number }) => {
    setPageAspects((prev) => {
      if (!page.width) return prev;
      const aspect = page.height / page.width;
      if (prev[page.pageNumber] === aspect) return prev;
      return { ...prev, [page.pageNumber]: aspect };
    });
  };

  // Document is mounted only when mayLoad (declared above the effects) is
  // true: either the file is under threshold, or the user clicked "Load
  // anyway". Mounting it earlier would make react-pdf start fetching/parsing
  // immediately, which is exactly what the gate exists to prevent.

  return (
    <div ref={containerRef} style={styles.container}>
      {gate.sizeUnknown && (
        <LoadingOverlay message="Checking PDF size..." />
      )}

      {gate.error && (
        <FileGateError message={gate.error} onRetry={gate.retry} />
      )}

      {gate.isLarge && !gate.bypassed && (
        <LargeFileWarning
          size={gate.size!}
          flavor="PDF"
          onForceLoad={gate.forceLoad}
          url={url}
        />
      )}

      {mayLoad && numPages === 0 && !error && (
        <LoadingOverlay
          message={slowLoad ? 'PDF is large, still loading...' : 'Loading PDF...'}
        />
      )}

      {error && (
        <div style={styles.errorBox}>
          <p style={styles.errorText}>{error}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      )}

      {mayLoad && (
        <Document
          file={url}
          onLoadSuccess={onLoadSuccess}
          onLoadError={onLoadError}
          loading=""
          error=""
        >
        {numPages > 0 && pageWidth && Array.from({ length: numPages }, (_, i) => {
          const pageNum = i + 1;
          const isVisible = visiblePages.has(pageNum);
          // Placeholder keeps its slot in the document flow with either the
          // real aspect (cached after first render) or an A4 estimate, so
          // the scrollbar stays stable while pages mount/unmount. Using
          // aspect (not absolute height) makes placeholders resize correctly
          // when pageWidth changes.
          const aspect = pageAspects[pageNum] ?? ESTIMATED_ASPECT;
          const placeholderHeight = aspect * pageWidth;
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
                // ResizeObserver feeds that width back into pageWidth — kicks
                // off a self-sustaining flicker/jump loop (see scrollbarGutter
                // note below).
                height: isVisible ? 'auto' : placeholderHeight,
                minHeight: placeholderHeight,
              }}
            >
              {isVisible ? (
                <Page
                  pageNumber={pageNum}
                  width={pageWidth}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  loading={<PageSpinner />}
                  onLoadSuccess={onPageLoadSuccess}
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
        </Document>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%', overflow: 'auto', padding: 12,
    background: c.bgSubtle, minWidth: 0,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    fontFamily: font.sans,
    position: 'relative',
    // Reserve a stable gutter for the scrollbar even when content doesn't
    // overflow. The ResizeObserver feeds contentRect.width back into
    // pageWidth, so without this, the scrollbar appearing/disappearing as
    // pages mount/unmount changes the available width a few pixels each way,
    // which re-renders every page, which shifts total height, which toggles
    // the scrollbar again — a self-sustaining flicker/jump loop even with no
    // user interaction. `stable` keeps the gutter constant so the width is
    // invariant to overflow state, breaking the feedback loop.
    scrollbarGutter: 'stable',
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
  downloadLink: {
    padding: '6px 16px', borderRadius: radius.md,
    border: `1px solid ${c.danger}`, color: c.danger,
    textDecoration: 'none', fontSize: 13,
  },
};

function PageSpinner() {
  return <div style={styles.placeholderSpinner} />;
}
