import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelRequest,
  fileRawUrl,
  friendlyMessage,
  officeCacheVirtualPath,
  officeConvert,
  type OfficePreviewOutput,
} from '../api/client';
import { useSse } from '../state/events';
import { c } from '../theme';
import { FileDownloadLink } from './FileDownloadLink';
import {
  LoadingOverlay,
  styles,
} from './previewShared';

const PdfPreview = lazy(() => import('./PdfPreview').then((m) => ({ default: m.PdfPreview })));
const CsvPreview = lazy(() => import('./CsvPreview').then((m) => ({ default: m.CsvPreview })));

interface Props {
  agentId: string;
  root: string;
  path: string;
}

type Phase =
  | { kind: 'converting'; message: string }
  | { kind: 'ready'; outputs: OfficePreviewOutput[] }
  | { kind: 'error'; message: string; cancelled?: boolean };

function createRequestUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function cancelOfficeRequest(agentId: string, reqId: string): Promise<void> {
  // The convert POST is issued first, but a very fast click can put /cancel on
  // the wire before the Hub has inserted the pending request. Retry only that
  // narrow 404 race; all other failures remain best-effort and bounded.
  for (const delay of [0, 50, 150]) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      await cancelRequest(agentId, reqId);
      return;
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status !== 404) return;
    }
  }
}

export function OfficePreview({ agentId, root, path }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'converting', message: 'Preparing preview…' });
  const [retryToken, setRetryToken] = useState(0);
  const [selectedOutput, setSelectedOutput] = useState(0);
  const reqIdRef = useRef<string | null>(null);
  const clientNonceRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convertingRef = useRef(false);

  const cancelConvert = useCallback(() => {
    convertingRef.current = false;
    const req = reqIdRef.current;
    reqIdRef.current = null;
    if (req) void cancelOfficeRequest(agentId, req);
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: 'error', message: 'Conversion cancelled.', cancelled: true });
  }, [agentId]);

  const retryConvert = useCallback(() => {
    setPhase({ kind: 'converting', message: 'Preparing preview…' });
    setRetryToken((n) => n + 1);
  }, []);

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
    const clientNonce = createRequestUuid();
    clientNonceRef.current = clientNonce;
    const reqId = `office_convert_${clientNonce}`;
    // Known before the first SSE event, so Cancel remains functional even
    // while the events connection is reconnecting.
    reqIdRef.current = reqId;
    const controller = new AbortController();
    abortRef.current = controller;

    officeConvert(agentId, root, path, reqId, clientNonce, controller.signal)
      .then((result) => {
        if (cancelled) return;
        convertingRef.current = false;
        reqIdRef.current = null;
        clientNonceRef.current = null;
        abortRef.current = null;
        setSelectedOutput(0);
        setPhase({ kind: 'ready', outputs: result.outputs });
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
      const req = reqIdRef.current;
      reqIdRef.current = null;
      clientNonceRef.current = null;
      if (req) void cancelOfficeRequest(agentId, req);
      controller.abort();
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
                onClick={retryConvert}
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

  const output = phase.outputs[selectedOutput] || phase.outputs[0];
  const derivedPath = officeCacheVirtualPath(output.cache_key, output.format);

  if (output.format === 'csv') {
    return (
      <div style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: c.bg,
      }}>
        {phase.outputs.length > 1 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: `1px solid ${c.border}`,
            background: c.surface,
            color: c.textMuted,
            fontSize: 12,
          }}>
            <span>Worksheet</span>
            <select
              value={selectedOutput}
              onChange={(event) => setSelectedOutput(Number(event.target.value))}
              style={{
                minWidth: 120,
                maxWidth: 320,
                padding: '4px 8px',
                border: `1px solid ${c.border}`,
                borderRadius: 6,
                background: c.bg,
                color: c.text,
              }}
            >
              {phase.outputs.map((item, index) => (
                <option key={item.cache_key} value={index}>{item.label}</option>
              ))}
            </select>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={(
            <div style={styles.container}>
              <LoadingOverlay message="Loading CSV viewer..." />
            </div>
          )}>
            <CsvPreview
              key={derivedPath}
              url={fileRawUrl(agentId, root, derivedPath)}
              ext="csv"
              path={derivedPath}
              downloadPath={path}
              agentId={agentId}
              root={root}
            />
          </Suspense>
        </div>
      </div>
    );
  }

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
        downloadPath={path}
        onRetry={retryConvert}
      />
    </Suspense>
  );
}
