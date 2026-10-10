import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  useFetchText,
  useFileGate,
  FileGateError,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  CopyButton,
  LoadingOverlay,
  gateLoadingMessage,
  previewLoadingMessage,
  styles,
} from './previewShared';
import { getViewerState, setViewerState } from './previewKeepAlive';
import { FileDownloadLink } from './FileDownloadLink';

interface Props {
  url: string;
  agentId: string;
  root: string;
  path: string;
  /** Pin state-restore key (see previewKeepAlive). */
  stateKey?: string;
}

export function MarkdownPreview({ url, agentId, root, path, stateKey }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.markdown });
  const canLoad = !gate.sizeUnknown && !gate.error && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, retrying, cancel, retry, received, total, slow } = useFetchText(url, canLoad, agentId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin = keep state: restore scroll after content mounts; save on unmount.
  useEffect(() => {
    if (!stateKey || !text) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = getViewerState(stateKey);
    if (saved?.kind === 'scroll') {
      el.scrollTop = saved.scrollTop;
      if (saved.scrollLeft != null) el.scrollLeft = saved.scrollLeft;
    }
    return () => {
      setViewerState(stateKey, {
        kind: 'scroll',
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
      });
    };
  }, [stateKey, text]);

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
        flavor="markdown"
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
        <LoadingOverlay message={previewLoadingMessage(retrying, 'Loading markdown...', { received, total }, slow)} onCancel={cancel} />
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

  const raw = text!;
  const isTruncated = raw.length > 500000;
  const displayText = isTruncated ? raw.slice(0, 500000) + '\n\n---\n*File truncated*' : raw;

  return (
    <div ref={scrollRef} style={styles.markdownContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>{raw.length.toLocaleString()} chars{isTruncated ? ' · truncated' : ''}</span>
        <CopyButton text={raw} />
      </div>
      <div className="markdown" style={{ ...styles.markdown, marginTop: 0 }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: (props) => (
              <div style={styles.tableWrap}>
                <table>{props.children}</table>
              </div>
            ),
          }}
        >
          {displayText}
        </ReactMarkdown>
      </div>
    </div>
  );
}
