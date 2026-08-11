import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { createPreviewSession } from '../api/client';
import { retryAsync } from '../api/retry';
import { c } from '../theme';

import {
  useFetchText,
  useFileGate,
  FileGateError,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  useMounted,
  LoadingOverlay,
  gateLoadingMessage,
  previewLoadingMessage,
  styles,
} from './previewShared';
import { FileDownloadLink } from './FileDownloadLink';

interface Props {
  agentId: string;
  root: string;
  path: string;
  url: string;
}

const HTML_SANDBOX = 'allow-scripts allow-downloads';

// Outer page is a top-level blob: URL (renders fine in Safari). The inner
// iframe loads the tokenized document URL directly — the hub serves it in
// document mode (injected <base> + CSP), so relative links and #anchors keep
// working. srcdoc cannot do that for a document that must navigate itself.
function makeSandboxWrapper(documentUrl: string): string {
  const origin = new URL(documentUrl).origin;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src ${origin};">
<title>HTML Preview</title>
<style>
html,body{margin:0;width:100%;height:100%;background:${c.surface};}
iframe{border:0;width:100%;height:100%;}
</style>
</head>
<body>
<iframe sandbox="${HTML_SANDBOX}" src="${documentUrl}" title="HTML Preview"></iframe>
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
  const shouldLoad = !gate.sizeUnknown && !gate.error && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, retrying, cancel, retry, received, total, slow } = useFetchText(url, shouldLoad, agentId);
  const previewShouldLoad = shouldLoad && text !== null && !error;
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [slowPreviewSetup, setSlowPreviewSetup] = useState(false);
  const [previewRetryToken, setPreviewRetryToken] = useState(0);
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [slowRendering, setSlowRendering] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [dismissedFileKey, setDismissedFileKey] = useState<string | null>(null);
  const mounted = useMounted();
  const previewCancelRef = useRef<AbortController | null>(null);
  const previewSetupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperUrlRef = useRef<string | null>(null);
  const wrapperRevokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const missingHtml = useMemo(() => {
    if (!text) return false;
    return !/<html[\s>]/i.test(text);
  }, [text]);

  const fileKey = `${root}:${path}`;
  const docWarningHidden = dismissedFileKey === fileKey;

  useEffect(() => {
    if (!previewShouldLoad) {
      previewCancelRef.current?.abort();
      previewCancelRef.current = null;
      if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      setDocumentUrl(null);
      setPreviewError(null);
      setPreviewLoading(false);
      setSlowPreviewSetup(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    previewCancelRef.current = controller;
    setDocumentUrl(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setSlowPreviewSetup(false);
    if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    previewSetupTimerRef.current = setTimeout(() => {
      if (mounted.current) setSlowPreviewSetup(true);
    }, 8000);
    void (async () => {
      try {
        const session = await retryAsync(
          () => createPreviewSession(agentId, root, path, controller.signal),
          {
            maxAttempts: 3,
            agentId,
            signal: controller.signal,
            onRetry: () => {
              if (!cancelled && mounted.current) setSlowPreviewSetup(true);
            },
          },
        );
        if (cancelled || !mounted.current) return;
        // The hub serves this URL in document mode for navigation requests,
        // injecting the sandbox guards (absolute <base>, CSP meta, anchor
        // fixup) server-side.
        setDocumentUrl(new URL(session.document_url, window.location.href).href);
        setIframeKey((k) => k + 1);
        setIframeLoading(true);
        setSlowRendering(false);
        setPreviewLoading(false);
        setSlowPreviewSetup(false);
        if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string; error?: string };
        if (err?.name === 'AbortError') return;
        if (cancelled || !mounted.current) return;
        setPreviewError(err?.message || err?.error || 'Failed to prepare HTML preview');
        setPreviewLoading(false);
        setSlowPreviewSetup(false);
        if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (previewCancelRef.current === controller) previewCancelRef.current = null;
      if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    };
  }, [agentId, root, path, previewShouldLoad, previewRetryToken, mounted]);

  useEffect(() => {
    if (!iframeLoading || showSource || !documentUrl) return;
    slowTimerRef.current = setTimeout(() => {
      if (mounted.current) setSlowRendering(true);
    }, 8000);
    return () => {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [iframeLoading, showSource, documentUrl, mounted]);

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
    if (!documentUrl) return;
    if (wrapperRevokeTimerRef.current) clearTimeout(wrapperRevokeTimerRef.current);
    if (wrapperUrlRef.current) URL.revokeObjectURL(wrapperUrlRef.current);

    const wrapperBlob = new Blob([makeSandboxWrapper(documentUrl)], { type: 'text/html' });
    const wrapperUrl = URL.createObjectURL(wrapperBlob);
    wrapperUrlRef.current = wrapperUrl;
    window.open(wrapperUrl, '_blank', 'noopener,noreferrer');
    wrapperRevokeTimerRef.current = setTimeout(() => {
      if (wrapperUrlRef.current === wrapperUrl) {
        URL.revokeObjectURL(wrapperUrl);
        wrapperUrlRef.current = null;
      }
    }, 60000);
  }, [documentUrl]);

  const handleRefresh = useCallback(() => {
    if (!documentUrl) return;
    setIframeLoading(true);
    setSlowRendering(false);
    setIframeKey((k) => k + 1);
  }, [documentUrl]);

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
        <LoadingOverlay
          message={gateLoadingMessage(gate.retrying)}
          onCancel={gate.cancel}
        />
      </div>
    );
  }
  if (gate.error) return <FileGateError message={gate.error} onRetry={gate.retry} />;
  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="HTML"
        onForceLoad={gate.forceLoad}
        agentId={agentId}
        root={root}
        path={path}
      />
    );
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message={previewLoadingMessage(retrying, 'Loading HTML...', { received, total }, slow)} onCancel={cancel} />
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
            <FileDownloadLink agentId={agentId} root={root} path={path} style={styles.downloadLink} />
          </div>
        </div>
      </div>
    );
  }
  if (previewLoading || (!showSource && text !== null && !documentUrl && !previewError)) {
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
            <FileDownloadLink agentId={agentId} root={root} path={path} style={styles.downloadLink} />
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

      {missingHtml && !docWarningHidden && (
        <div style={docWarningBanner}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={docWarningTitle}>Non-standard HTML structure</div>
            <div style={docWarningBody}>
              The file is missing an <code>{'<html>'}</code> element. Browsers handle this gracefully, but you can{' '}
              <FileDownloadLink agentId={agentId} root={root} path={path} style={styles.downloadLink}>download</FileDownloadLink> the original file if needed.
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
            key={iframeKey}
            ref={iframeRef}
            src={documentUrl || ''}
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
