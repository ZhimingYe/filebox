import { useState, useEffect, useRef, useCallback } from 'react';
import { fileRawUrl } from '../api/client';

import {
  useFetchText,
  useFileGate,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  useMounted,
  LoadingOverlay,
  styles,
} from './previewShared';

interface Props {
  agentId: string;
  root: string;
  path: string;
  url: string;
}

// Inject <base> tag into HTML for relative path resolution.
function injectBaseTag(html: string, baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const escapedUrl = normalizedBaseUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const newBase = `<base href="${escapedUrl}" target="_blank">`;

  const existingMatch = html.match(/<base\b[^>]*>/i);
  if (existingMatch) {
    const existing = existingMatch[0];
    if (/target\s*=/i.test(existing)) return html;
    const withTarget = existing.replace(/<base\b/i, '<base target="_blank" ');
    return html.replace(/<base\b[^>]*>/i, withTarget);
  }

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertPos = html.indexOf(headMatch[0]) + headMatch[0].length;
    return html.slice(0, insertPos) + `\n${newBase}` + html.slice(insertPos);
  }

  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const insertPos = html.indexOf(htmlMatch[0]) + htmlMatch[0].length;
    return html.slice(0, insertPos) + `\n<head>${newBase}</head>` + html.slice(insertPos);
  }

  return `${newBase}\n${html}`;
}

export function HtmlPreview({ agentId, root, path, url }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.html });
  const { text, error, loading, cancel, retry } = useFetchText(url);

  if (gate.sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking file size..." />
      </div>
    );
  }
  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="HTML"
        onForceLoad={gate.forceLoad}
        url={url}
      />
    );
  }
  const [iframeLoading, setIframeLoading] = useState(true);
  const [slowRendering, setSlowRendering] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const mounted = useMounted();
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirPath = path.replace(/\/[^/]*$/, '/');
  const baseUrl = fileRawUrl(agentId, root, dirPath);

  useEffect(() => {
    if (!text) return;
    const processedHtml = injectBaseTag(text, baseUrl);
    const blob = new Blob([processedHtml], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    blobUrlRef.current = blobUrl;
    setIframeLoading(true);
    setSlowRendering(false);

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [text, baseUrl]);

  useEffect(() => {
    if (!iframeLoading || showSource) return;
    slowTimerRef.current = setTimeout(() => {
      if (mounted.current) setSlowRendering(true);
    }, 8000);
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [iframeLoading, showSource, mounted]);

  useEffect(() => () => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  }, []);

  const handleIframeLoad = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    setIframeLoading(false);
    setSlowRendering(false);
  }, []);

  const handleIframeError = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    setIframeLoading(false);
    setSlowRendering(false);
  }, []);

  const openInNewWindow = useCallback(() => {
    if (blobUrlRef.current) {
      window.open(blobUrlRef.current, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleRefresh = useCallback(() => {
    const iframe = iframeRef.current;
    const blobUrl = blobUrlRef.current;
    if (!iframe || !blobUrl) return;
    setIframeLoading(true);
    setSlowRendering(false);
    iframe.src = 'about:blank';
    requestAnimationFrame(() => {
      if (iframeRef.current) iframeRef.current.src = blobUrl;
    });
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
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{error}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={retry} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.htmlContainer}>
      <div style={styles.htmlToolbar}>
        <button onClick={handleRefresh} style={styles.toolbarBtn} title="Reload preview">
          &#x21bb;
        </button>
        <button onClick={() => setShowSource(!showSource)} style={styles.toolbarBtn} title="Toggle source">
          {showSource ? 'Preview' : 'Source'}
        </button>
        <button onClick={openInNewWindow} style={styles.toolbarBtn} title="Open in new window">
          &#x2197;
        </button>
      </div>

      <div style={styles.htmlContent}>
        {!showSource && iframeLoading && (
          <LoadingOverlay
            message={slowRendering ? 'Still rendering — large or script-heavy HTML...' : 'Rendering...'}
          />
        )}
        {showSource ? (
          <pre style={styles.sourceCode}>{text}</pre>
        ) : (
          <iframe
            ref={iframeRef}
            src={blobUrlRef.current || ''}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox"
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
