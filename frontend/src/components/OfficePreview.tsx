import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelRequest,
  fileRawUrl,
  friendlyMessage,
  officeCacheVirtualPath,
  officeConvert,
} from '../api/client';
import { useSse } from '../state/events';
import { c } from '../theme';
import { FileDownloadLink } from './FileDownloadLink';
import {
  LoadingOverlay,
  LargeFileWarning,
  useFileGate,
  FileGateError,
  PREVIEW_SIZE_THRESHOLDS,
  styles,
} from './previewShared';

const PdfPreview = lazy(() => import('./PdfPreview').then((m) => ({ default: m.PdfPreview })));

interface Props {
  agentId: string;
  root: string;
  path: string;
}

type Phase =
  | { kind: 'gate' }
  | { kind: 'converting'; message: string }
  | { kind: 'ready'; cacheKey: string }
  | { kind: 'error'; message: string; cancelled?: boolean };

export function OfficePreview({ agentId, root, path }: Props) {
  // Gate on the *source* Office file size before starting LibreOffice.
  const gate = useFileGate({
    agentId,
    root,
    path,
    threshold: PREVIEW_SIZE_THRESHOLDS.pdf,
  });
  const mayConvert = !gate.sizeUnknown && !gate.error && !(gate.isLarge && !gate.bypassed);

  const [phase, setPhase] = useState<Phase>({ kind: 'gate' });
  const [retryToken, setRetryToken] = useState(0);
  const reqIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convertingRef = useRef(false);

  const cancelConvert = useCallback(() => {
    convertingRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    const req = reqIdRef.current;
    reqIdRef.current = null;
    if (req) void cancelRequest(agentId, req).catch(() => {});
    setPhase({ kind: 'error', message: 'Conversion cancelled.', cancelled: true });
  }, [agentId]);

  useSse(useCallback((evt) => {
    if (evt.event !== 'progress' || !convertingRef.current) return;
    const d = evt.data as {
      req_id?: string;
      phase?: string;
      message?: string | null;
    };
    if (!d.req_id || !d.phase) return;
    if (!['preparing', 'converting', 'caching'].includes(d.phase)) return;
    if (!reqIdRef.current) reqIdRef.current = d.req_id;
    if (reqIdRef.current !== d.req_id) return;
    setPhase({
      kind: 'converting',
      message: d.message || 'Preparing preview…',
    });
  }, []));

  useEffect(() => {
    if (!mayConvert) {
      setPhase({ kind: 'gate' });
      return;
    }

    let cancelled = false;
    convertingRef.current = true;
    reqIdRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'converting', message: 'Preparing preview…' });

    officeConvert(agentId, root, path, controller.signal)
      .then((result) => {
        if (cancelled) return;
        convertingRef.current = false;
        reqIdRef.current = null;
        abortRef.current = null;
        setPhase({ kind: 'ready', cacheKey: result.cache_key });
      })
      .catch((e: { error?: string; message?: string; name?: string }) => {
        if (cancelled || e?.name === 'AbortError') return;
        convertingRef.current = false;
        abortRef.current = null;
        reqIdRef.current = null;
        if (e?.error === 'cancelled') {
          setPhase({ kind: 'error', message: 'Conversion cancelled.', cancelled: true });
          return;
        }
        setPhase({
          kind: 'error',
          message: friendlyMessage(e) || e?.message || 'Conversion failed.',
        });
      });

    return () => {
      cancelled = true;
      convertingRef.current = false;
      controller.abort();
      const req = reqIdRef.current;
      reqIdRef.current = null;
      if (req) void cancelRequest(agentId, req).catch(() => {});
    };
  }, [agentId, root, path, mayConvert, retryToken]);

  if (gate.sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking file size..." />
      </div>
    );
  }

  if (gate.error) {
    return <FileGateError message={gate.error} onRetry={gate.retry} />;
  }

  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="Office document"
        onForceLoad={gate.forceLoad}
        agentId={agentId}
        root={root}
        path={path}
      />
    );
  }

  if (phase.kind === 'converting' || phase.kind === 'gate') {
    return (
      <div style={styles.container}>
        <LoadingOverlay
          message={phase.kind === 'converting' ? phase.message : 'Preparing…'}
          onCancel={cancelConvert}
        />
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div style={styles.container}>
        <div style={styles.download}>
          <p style={styles.downloadText}>{phase.message}</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            {!phase.cancelled && (
              <button
                type="button"
                onClick={() => setRetryToken((n) => n + 1)}
                style={{
                  padding: '6px 12px',
                  border: `1px solid ${c.border}`,
                  borderRadius: 6,
                  background: c.surface,
                  color: c.text,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Retry
              </button>
            )}
            <FileDownloadLink
              agentId={agentId}
              root={root}
              path={path}
              style={styles.downloadLink}
            />
          </div>
        </div>
      </div>
    );
  }

  const derivedPath = officeCacheVirtualPath(phase.cacheKey);
  const derivedUrl = fileRawUrl(agentId, root, derivedPath);

  return (
    <Suspense
      fallback={(
        <div style={styles.container}>
          <LoadingOverlay message="Loading PDF viewer..." />
        </div>
      )}
    >
      <PdfPreview
        key={derivedPath}
        agentId={agentId}
        root={root}
        path={derivedPath}
        url={derivedUrl}
      />
    </Suspense>
  );
}
