import { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { c, radius, shadow, font } from '../theme';
import { LoadingOverlay } from './previewShared';

// Vite bundles the worker with the app via new URL(...). Avoids CDN dep
// and keeps the install offline-capable.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface Props {
  url: string;
}

// Browser-native PDF viewers (via <iframe>) don't exist on iOS Safari and
// are flaky on some Android browsers — the iframe comes up blank. PDF.js
// renders to <canvas> so it works on every browser, at the cost of pulling
// in pdfjs-dist (~500KB) which we lazy-load via React.lazy at the call site.
export function PdfPreview({ url }: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  // Slow-load detection: 8s timer reset when numPages arrives.
  useEffect(() => {
    if (numPages > 0) {
      setSlowLoad(false);
      return;
    }
    const t = setTimeout(() => setSlowLoad(true), 8000);
    return () => clearTimeout(t);
  }, [numPages]);

  const onLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setError(null);
  };

  const onLoadError = (err: Error) => {
    setError(err.message || 'Failed to load PDF');
    setNumPages(0);
  };

  // pageWidth: leave a little padding; pdf.js v6 requires an explicit pixel width.
  const pageWidth = containerWidth > 0 ? Math.max(200, containerWidth - 24) : undefined;

  return (
    <div ref={containerRef} style={styles.container}>
      {numPages === 0 && !error && (
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

      <Document
        file={url}
        onLoadSuccess={onLoadSuccess}
        onLoadError={onLoadError}
        loading=""
        error=""
      >
        {numPages > 0 && pageWidth && Array.from({ length: numPages }, (_, i) => (
          <div key={i + 1} style={styles.pageWrap}>
            <Page
              pageNumber={i + 1}
              width={pageWidth}
              renderAnnotationLayer={false}
              renderTextLayer={false}
              loading=""
            />
          </div>
        ))}
      </Document>
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
  },
  pageWrap: {
    background: c.surface, borderRadius: radius.md,
    boxShadow: shadow.sm, overflow: 'hidden',
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
