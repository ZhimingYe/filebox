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

// ── Scroll-position cache ────────────────────────────────────────────────
// The only viewer state preserved across tab switches: where the user was
// reading in an HTML document. Keyed by file (agentId:root:path), bounded,
// and restored ONLY when the file is unchanged — verified via the hub's
// strong ETag ("size-mtime") on the raw fetch (see useFetchText's `etag`).
// A changed file (or one without an ETag — no mtime on the filesystem)
// never gets its scroll restored, so the user is never jumped to a stale
// position in new content. Everything else (zoom, source view, iframe
// reloads) resets on tab switch by design — keeping hidden bodies mounted
// roughly quintupled HTML preview load.
const MAX_HTML_SCROLL_CACHE = 20;
const htmlScrollCache = new Map<string, { x: number; y: number; etag: string }>();

function scrollCacheKey(agentId: string, root: string, path: string): string {
  return `${agentId}:${root}:${path}`;
}

function cacheHtmlScroll(key: string, x: number, y: number, etag: string | null) {
  if (!etag) return; // No validator → cannot prove "unchanged" later; don't cache.
  htmlScrollCache.set(key, { x, y, etag });
  if (htmlScrollCache.size > MAX_HTML_SCROLL_CACHE) {
    const oldest = htmlScrollCache.keys().next().value;
    if (oldest !== undefined) htmlScrollCache.delete(oldest);
  }
}

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
  const { text, error, loading, retrying, cancel, retry, received, total, slow, etag } = useFetchText(url, shouldLoad, agentId);
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
  // Latest ETag of the fetched raw text, readable from effects/cleanups that
  // capture render-scope values (a `[]` cleanup would otherwise see null).
  // Kept in sync via an effect — the react-hooks/refs rule forbids writing
  // a ref during render.
  const etagRef = useRef<string | null>(null);
  useEffect(() => {
    etagRef.current = etag;
  }, [etag]);
  // Scroll position to restore once the iframe finishes loading (only set
  // when the saved ETag matches the freshly fetched one).
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null);

  const missingHtml = useMemo(() => {
    if (!text) return false;
    return !/<html[\s>]/i.test(text);
  }, [text]);

  const fileKey = `${root}:${path}`;
  // agentId included so switching backends never restores another machine's
  // same-path document position.
  const scrollKey = scrollCacheKey(agentId, root, path);
  const docWarningHidden = dismissedFileKey === fileKey;

  useEffect(() => {
    if (!previewShouldLoad) {
      previewCancelRef.current?.abort();
      previewCancelRef.current = null;
      if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
      pendingScrollRef.current = null;
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
        // Restore the saved reading position only when the file is
        // unchanged: the ETag captured from this fetch must equal the one
        // saved with the position (a changed file, or one without an ETag,
        // never restores). handleRefresh clears this before its iframe
        // reload so a manual refresh starts fresh.
        const cached = htmlScrollCache.get(scrollKey);
        pendingScrollRef.current = cached && cached.etag === etagRef.current
          ? { x: cached.x, y: cached.y }
          : null;
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
    // scrollKey derives from the props already listed; listed too so the
    // effect re-runs if the key scheme ever changes.
  }, [agentId, root, path, scrollKey, previewShouldLoad, previewRetryToken, mounted]);

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
    // Cache the reading position before the viewer unmounts (tab switch,
    // close, mobile file switch). Only saved — restored on a later mount
    // only when the file's ETag still matches (see the setup effect).
    const win = iframeRef.current?.contentWindow;
    if (win) {
      cacheHtmlScroll(scrollKey, win.scrollX, win.scrollY, etagRef.current);
    }
    previewCancelRef.current?.abort();
    if (previewSetupTimerRef.current) clearTimeout(previewSetupTimerRef.current);
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    if (wrapperRevokeTimerRef.current) clearTimeout(wrapperRevokeTimerRef.current);
    if (wrapperUrlRef.current) URL.revokeObjectURL(wrapperUrlRef.current);
    // scrollKey is constant for the lifetime of this mount (props never
    // change in place — the parent remounts the pane on file switch), so
    // the cleanup always saves under the key that matches the iframe.
  }, [scrollKey]);

  const handleIframeLoad = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    setIframeLoading(false);
    setSlowRendering(false);
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (pending) {
      const win = iframeRef.current?.contentWindow;
      if (win) {
        win.scrollTo(pending.x, pending.y);
        // Late-loading content (images, scripts) can shift layout after the
        // load event; re-apply on the next frame so the restore sticks.
        requestAnimationFrame(() => {
          const w = iframeRef.current?.contentWindow;
          if (w) w.scrollTo(pending.x, pending.y);
        });
      }
    }
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
    // A manual refresh is an explicit "look again" — never restore the old
    // reading position onto the reloaded document.
    pendingScrollRef.current = null;
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
