import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { createPreviewSession } from '../api/client';
import { c } from '../theme';

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

const HTML_SANDBOX = 'allow-scripts allow-downloads';

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function previewCsp(baseUrl: string): string {
  const source = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${source}`,
    `style-src 'unsafe-inline' ${source}`,
    `img-src data: blob: ${source}`,
    `font-src data: ${source}`,
    `connect-src ${source}`,
    `media-src blob: ${source}`,
    `worker-src blob: ${source}`,
    `frame-src blob: ${source}`,
    `navigate-to blob: ${source}`,
    `base-uri ${source}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

// Inject a locked <base> and CSP meta so relative resources resolve through
// the tokenized preview endpoint instead of the main Filebox API surface.
function injectPreviewGuards(html: string, baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const escapedBaseUrl = escapeAttr(normalizedBaseUrl);
  const escapedCsp = escapeAttr(previewCsp(normalizedBaseUrl));
  const guardTags = [
    `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">`,
    `<base href="${escapedBaseUrl}" target="_self">`,
  ].join('\n');
  const withoutExistingBase = html.replace(/<base\b[^>]*>/gi, '');

  const headMatch = withoutExistingBase.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertPos = withoutExistingBase.indexOf(headMatch[0]) + headMatch[0].length;
    return withoutExistingBase.slice(0, insertPos) + `\n${guardTags}` + withoutExistingBase.slice(insertPos);
  }

  const htmlMatch = withoutExistingBase.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const insertPos = withoutExistingBase.indexOf(htmlMatch[0]) + htmlMatch[0].length;
    return withoutExistingBase.slice(0, insertPos) + `\n<head>${guardTags}</head>` + withoutExistingBase.slice(insertPos);
  }

  return `${guardTags}\n${withoutExistingBase}`;
}

function detectDocIssues(html: string): { missingHtml: boolean; missingCharset: boolean } {
  const missingHtml = !/<html[\s>]/i.test(html);
  const head = html.slice(0, 1024);
  const hasCharset = /<meta\b[^>]*charset/i.test(head);
  return { missingHtml, missingCharset: !hasCharset };
}

function makeSandboxWrapper(blobUrl: string): string {
  const escapedBlobUrl = escapeAttr(blobUrl);
  const escapedSandbox = escapeAttr(HTML_SANDBOX);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'; navigate-to blob:;">
<title>HTML Preview</title>
<style>
html,body{margin:0;width:100%;height:100%;background:${c.surface};}
iframe{border:0;width:100%;height:100%;}
</style>
</head>
<body>
<iframe sandbox="${escapedSandbox}" src="${escapedBlobUrl}" title="HTML Preview"></iframe>
</body>
</html>`;
}

const docWarningBanner: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 12,
  padding: '10px 14px', background: c.warningBg,
  borderBottom: `1px solid ${c.border}`, flexShrink: 0,
};
const docWarningTitle: CSSProperties = {
  color: c.warning, fontWeight: 600, fontSize: 12.5, marginBottom: 2,
};
const docWarningBody: CSSProperties = {
  color: c.textSecondary, fontSize: 12, lineHeight: 1.5,
};
const docWarningClose: CSSProperties = {
  flexShrink: 0, border: 'none', background: 'transparent',
  color: c.textMuted, cursor: 'pointer', fontSize: 16, lineHeight: 1,
  padding: '0 2px', alignSelf: 'flex-start',
};

export function HtmlPreview({ agentId, root, path, url }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.html });
  const shouldLoad = !gate.sizeUnknown && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, cancel, retry } = useFetchText(url, shouldLoad);
  const previewShouldLoad = shouldLoad && text !== null && !error;
  const [previewBaseUrl, setPreviewBaseUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [slowPreviewSetup, setSlowPreviewSetup] = useState(false);
  const [previewRetryToken, setPreviewRetryToken] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [slowRendering, setSlowRendering] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [dismissedFileKey, setDismissedFileKey] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mounted = useMounted();
  const previewCancelRef = useRef<AbortController | null>(null);
  const previewSetupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperUrlRef = useRef<string | null>(null);
  const wrapperRevokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const docIssue = useMemo(() => {
    if (!text) return null;
    const { missingHtml, missingCharset } = detectDocIssues(text);
    if (!missingHtml && !missingCharset) return null;
    const parts: string[] = [];
    if (missingHtml) parts.push('<html>');
    if (missingCharset) parts.push('<meta charset="utf-8">');
    return { missing: parts.join(' and/or ') };
  }, [text]);

  const fileKey = `${root}:${path}`;
  const docWarningHidden = dismissedFileKey === fileKey;

  useEffect(() => {
    if (!previewShouldLoad) {
      previewCancelRef.current?.abort();
      previewCancelRef.current = null;
      if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      setPreviewBaseUrl(null);
      setPreviewError(null);
      setPreviewLoading(false);
      setSlowPreviewSetup(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    previewCancelRef.current = controller;
    setPreviewBaseUrl(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setSlowPreviewSetup(false);
    if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    previewSetupTimerRef.current = setTimeout(() => {
      if (mounted.current) setSlowPreviewSetup(true);
    }, 8000);
    createPreviewSession(agentId, root, path, controller.signal)
      .then((session) => {
        if (cancelled || !mounted.current) return;
        setPreviewBaseUrl(new URL(session.base_url, window.location.href).href);
        setPreviewLoading(false);
        setSlowPreviewSetup(false);
        if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (cancelled || !mounted.current) return;
        setPreviewError(e?.message || e?.error || 'Failed to prepare HTML preview');
        setPreviewLoading(false);
        setSlowPreviewSetup(false);
        if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (previewCancelRef.current === controller) previewCancelRef.current = null;
      if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    };
  }, [agentId, root, path, previewShouldLoad, previewRetryToken, mounted]);

  useEffect(() => {
    if (text === null || !previewBaseUrl) {
      setBlobUrl(null);
      return;
    }
    const processedHtml = injectPreviewGuards(text, previewBaseUrl);
    const blob = new Blob([processedHtml], { type: 'text/html' });
    const nextBlobUrl = URL.createObjectURL(blob);
    setBlobUrl(nextBlobUrl);
    setIframeLoading(true);
    setSlowRendering(false);

    return () => {
      URL.revokeObjectURL(nextBlobUrl);
    };
  }, [text, previewBaseUrl]);

  useEffect(() => {
    if (!iframeLoading || showSource || !blobUrl) return;
    slowTimerRef.current = setTimeout(() => {
      if (mounted.current) setSlowRendering(true);
    }, 8000);
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [iframeLoading, showSource, blobUrl, mounted]);

  useEffect(() => () => {
    previewCancelRef.current?.abort();
    if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    if (wrapperRevokeTimerRef.current) clearTimeout(wrapperRevokeTimerRef.current);
    if (wrapperUrlRef.current) URL.revokeObjectURL(wrapperUrlRef.current);
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
    if (!blobUrl) return;
    if (wrapperRevokeTimerRef.current) clearTimeout(wrapperRevokeTimerRef.current);
    if (wrapperUrlRef.current) URL.revokeObjectURL(wrapperUrlRef.current);

    const wrapperBlob = new Blob([makeSandboxWrapper(blobUrl)], { type: 'text/html' });
    const wrapperUrl = URL.createObjectURL(wrapperBlob);
    wrapperUrlRef.current = wrapperUrl;
    window.open(wrapperUrl, '_blank', 'noopener,noreferrer');
    wrapperRevokeTimerRef.current = setTimeout(() => {
      if (wrapperUrlRef.current === wrapperUrl) {
        URL.revokeObjectURL(wrapperUrl);
        wrapperUrlRef.current = null;
      }
    }, 60000);
  }, [blobUrl]);

  const handleRefresh = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !blobUrl) return;
    setIframeLoading(true);
    setSlowRendering(false);
    iframe.src = 'about:blank';
    requestAnimationFrame(() => {
      if (iframeRef.current) iframeRef.current.src = blobUrl;
    });
  }, [blobUrl]);

  const handlePreviewSetupCancel = useCallback(() => {
    previewCancelRef.current?.abort();
    previewCancelRef.current = null;
    if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    setPreviewLoading(false);
    setSlowPreviewSetup(false);
    setPreviewError('Cancelled');
  }, []);

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
  if (previewLoading || (!showSource && text !== null && !blobUrl && !previewError)) {
    return (
      <div style={styles.container}>
        <LoadingOverlay
          message={slowPreviewSetup ? 'Still preparing secure preview. The agent may be slow or reconnecting...' : 'Preparing secure HTML preview...'}
          onCancel={handlePreviewSetupCancel}
        />
      </div>
    );
  }
  if (previewError) {
    return (
      <div style={styles.container}>
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{previewError}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={() => setPreviewRetryToken((n) => n + 1)} style={styles.retryBtn}>Retry</button>
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

      {docIssue && !docWarningHidden && (
        <div style={docWarningBanner}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={docWarningTitle}>This HTML may render incorrectly</div>
            <div style={docWarningBody}>
              The file is missing {docIssue.missing}. Non-ASCII characters (e.g. Chinese) may appear garbled in this sandboxed preview.{' '}
              <a href={url} download style={styles.downloadLink}>Download</a> and open it directly, or manually add the missing tags near the top of the file.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissedFileKey(fileKey)}
            style={docWarningClose}
            aria-label="Dismiss warning"
            title="Dismiss"
          >&times;</button>
        </div>
      )}

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
            src={blobUrl || ''}
            sandbox={HTML_SANDBOX}
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
