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
  styles,
} from './previewShared';

const PdfPreview = lazy(() => import('./PdfPreview').then((m) => ({ default: m.PdfPreview })));

interface Props {
  agentId: string;
  root: string;
  path: string;
}

type Phase =
  | { kind: 'converting'; message: string }
  | { kind: 'ready'; cacheKey: string }
  | { kind: 'error'; message: string; cancelled?: boolean };

export function OfficePreview({ agentId, root, path }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'converting', message: 'Preparing preview…' });
  const [retryToken, setRetryToken] = useState(0);
  const reqIdRef = useRef<string | null>(null);
  const clientNonceRef = useRef<string | null>(null);
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
      client_nonce?: string | null;
    };
    if (!d.req_id || !d.phase) return;
    if (!['preparing', 'converting', 'caching'].includes(d.phase)) return;
    if (!reqIdRef.current) {
      if (!d.client_nonce || d.client_nonce !== clientNonceRef.current) return;
      reqIdRef.current = d.req_id;
    }
    if (reqIdRef.current !== d.req_id) return;
    setPhase({
      kind: 'converting',
      message: d.message || 'Preparing preview…',
    });
  }, []));

  useEffect(() => {
    let cancelled = false;
    convertingRef.current = true;
    reqIdRef.current = null;
    const clientNonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    clientNonceRef.current = clientNonce;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'converting', message: 'Preparing preview…' });

    officeConvert(agentId, root, path, clientNonce, controller.signal)
      .then((result) => {
        if (cancelled) return;
        convertingRef.current = false;
        reqIdRef.current = null;
        clientNonceRef.current = null;
        abortRef.current = null;
        setPhase({ kind: 'ready', cacheKey: result.cache_key });
      })
      .catch((e: { error?: string; message?: string; name?: string }) => {
        if (cancelled || e?.name === 'AbortError') return;
        convertingRef.current = false;
        abortRef.current = null;
        reqIdRef.current = null;
        clientNonceRef.current = null;
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
      clientNonceRef.current = null;
      if (req) void cancelRequest(agentId, req).catch(() => {});
    };
  }, [agentId, root, path, retryToken]);

  if (phase.kind === 'converting') {
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
        skipSizeGate
        downloadPath={path}
        onRetry={() => setRetryToken((n) => n + 1)}
      />
    </Suspense>
  );
}
