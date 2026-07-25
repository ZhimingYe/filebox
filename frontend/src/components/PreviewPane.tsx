import { memo, lazy, Suspense } from 'react';
import { fileRawUrl } from '../api/client';
import { FileDownloadLink } from './FileDownloadLink';
import { c } from '../theme';

import {
  isTextFile,
  isOfficePreviewExt,
  readOfficePdfPreviewPref,
  styles,
} from './previewShared';

// Heavy preview components are lazy-loaded so their deps only download when
// the user actually opens that file type. The biggest is TextPreview
// (monaco-editor ~2MB+), followed by MarkdownPreview (react-markdown +
// remark-gfm ~80KB). PdfPreview pulls pdfjs-dist (~500KB + 1.2MB worker)
// only when a PDF is opened. ImagePreview pulls UTIF (~50KB) only when a
// TIFF is opened.
const ImagePreview = lazy(() => import('./ImagePreview').then(m => ({ default: m.ImagePreview })));
const PdfPreview = lazy(() => import('./PdfPreview').then(m => ({ default: m.PdfPreview })));
const TextPreview = lazy(() => import('./TextPreview').then(m => ({ default: m.TextPreview })));
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(m => ({ default: m.MarkdownPreview })));
const HtmlPreview = lazy(() => import('./HtmlPreview').then(m => ({ default: m.HtmlPreview })));
const CsvPreview = lazy(() => import('./CsvPreview').then(m => ({ default: m.CsvPreview })));
const OfficePreview = lazy(() => import('./OfficePreview').then(m => ({ default: m.OfficePreview })));

interface Props {
  agentId: string;
  root: string;
  path: string;
  entryType: string;
  denied: boolean;
  /** Agent advertised office_pdf_preview capability. */
  officeCapable?: boolean;
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

function DownloadFallback({
  agentId, root, path, ext, hint,
}: {
  agentId: string;
  root: string;
  path: string;
  ext: string;
  hint?: string;
}) {
  return (
    <div style={styles.container}>
      <div style={styles.download}>
        <p style={styles.downloadText}>
          {hint || `No preview available for .${ext} files`}
        </p>
        <FileDownloadLink agentId={agentId} root={root} path={path} style={styles.downloadLink} />
      </div>
    </div>
  );
}

// Memoized so dragging the file/preview splitter (which re-renders App and
// would otherwise cascade into a Monaco layout pass on every animation
// frame) does not re-render the preview subtree. Props are all primitives
// that only change when the selected file changes.
export const PreviewPane = memo(function PreviewPane({
  agentId, root, path, entryType, denied, officeCapable = false,
}: Props) {
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
    // key by path so switching files (especially in mobile, where PreviewPane
    // itself isn't keyed) remounts ImagePreview — fresh zoom/rotation/pos
    // and a clean AbortController/blob-URL lifecycle per file.
    return (
      <Suspense fallback={<SuspenseFallback label="Loading image viewer..." />}>
        <ImagePreview key={`${root}:${path}`} agentId={agentId} root={root} path={path} url={url} ext={ext} />
      </Suspense>
    );
  }

  if (ext === 'pdf') {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading PDF viewer..." />}>
        <PdfPreview key={`${root}:${path}`} agentId={agentId} root={root} path={path} url={url} />
      </Suspense>
    );
  }

  if (['md', 'markdown'].includes(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading markdown viewer..." />}>
        <MarkdownPreview url={url} agentId={agentId} root={root} path={path} />
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
        <CsvPreview url={url} ext={ext} path={path} agentId={agentId} root={root} />
      </Suspense>
    );
  }

  if (isOfficePreviewExt(ext)) {
    const prefOn = readOfficePdfPreviewPref();
    if (officeCapable && prefOn) {
      return (
        <Suspense fallback={<SuspenseFallback label="Loading Office preview..." />}>
          <OfficePreview
            key={`${root}:${path}`}
            agentId={agentId}
            root={root}
            path={path}
          />
        </Suspense>
      );
    }
    const hint = !officeCapable
      ? `No preview available for .${ext} files (agent has no LibreOffice configured)`
      : `Office PDF preview is turned off in Settings`;
    return (
      <DownloadFallback agentId={agentId} root={root} path={path} ext={ext} hint={hint} />
    );
  }

  if (isTextFile(ext)) {
    return (
      <Suspense fallback={<SuspenseFallback label="Loading code viewer..." />}>
        <TextPreview url={url} ext={ext} agentId={agentId} root={root} path={path} />
      </Suspense>
    );
  }

  return (
    <DownloadFallback agentId={agentId} root={root} path={path} ext={ext} />
  );
});
