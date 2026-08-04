import { useState } from 'react';

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
import { FileDownloadLink } from './FileDownloadLink';
import {
  CSV_PREVIEW_ROWS,
  detectCsvDelimiter,
  parseCsvPreview,
} from './csvPreviewParser';

const CSV_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

interface Props {
  url: string;
  ext: string;
  path: string;
  downloadPath?: string;
  agentId: string;
  root: string;
}

export function CsvPreview({ url, ext, agentId, root, path, downloadPath = path }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.csv });
  const isTooLarge = gate.size !== null && gate.size > CSV_PREVIEW_MAX_BYTES;
  const canLoad = !gate.sizeUnknown
    && !gate.error
    && !isTooLarge
    && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, retrying, cancel, retry } = useFetchText(url, canLoad, agentId);
  const [view, setView] = useState<'table' | 'raw'>('table');

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
  if (isTooLarge) {
    return (
      <div style={styles.container}>
        <div style={styles.largeImageWarning}>
          <p style={styles.largeImageTitle}>
            CSV is too large to preview ({(gate.size! / (1024 * 1024)).toFixed(1)} MB)
          </p>
          <p style={styles.largeImageText}>
            Files larger than 15 MB are not loaded to keep this tab responsive.
          </p>
          <FileDownloadLink
            agentId={agentId}
            root={root}
            path={downloadPath}
            style={styles.downloadLink}
          >
            Download original file
          </FileDownloadLink>
        </div>
      </div>
    );
  }
  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="CSV"
        onForceLoad={gate.forceLoad}
        agentId={agentId}
        root={root}
        path={downloadPath}
      />
    );
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message={previewLoadingMessage(retrying, 'Loading CSV...')} onCancel={cancel} />
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
            <FileDownloadLink
              agentId={agentId}
              root={root}
              path={downloadPath}
              style={styles.downloadLink}
            />
          </div>
        </div>
      </div>
    );
  }

  const raw = text!;
  const defaultDelim = ext === 'tsv' ? '\t' : ',';
  const delim = detectCsvDelimiter(raw, defaultDelim);
  const delimLabel = delim === '\t' ? 'tab' : delim;
  const parsed = parseCsvPreview(raw, delim);
  const rows = parsed.rows;
  const isTruncated = parsed.totalRecords > CSV_PREVIEW_ROWS;
  const header = rows[0] || [];
  const bodyRows = rows.slice(1);
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div style={styles.codeContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>
          {parsed.totalRecords.toLocaleString()} rows{isTruncated ? ` · showing first ${CSV_PREVIEW_ROWS}` : ''} · delim: {delimLabel}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={() => setView(view === 'table' ? 'raw' : 'table')}
            style={styles.toolBtn}
            title="Toggle view"
          >
            {view === 'table' ? 'Raw' : 'Table'}
          </button>
          <CopyButton text={raw} />
        </div>
      </div>
      {view === 'raw' ? (
        <pre style={{
          ...styles.code,
          whiteSpace: 'pre',
          wordBreak: 'normal',
          overflow: 'auto',
        }}>{parsed.rawRecords.join('\n')}{isTruncated ? '\n\n... (truncated)' : ''}</pre>
      ) : (
        <div style={styles.csvTableWrap}>
          <table style={styles.csvTable}>
            {header.length > 0 && (
              <thead>
                <tr>
                  {Array.from({ length: maxCols }).map((_, i) => (
                    <th key={i} style={styles.csvTh}>{header[i] ?? ''}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {Array.from({ length: maxCols }).map((_, ci) => (
                    <td key={ci} style={styles.csvTd}>{row[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
