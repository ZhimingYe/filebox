import { useState } from 'react';

import {
  useFetchText,
  useFileGate,
  FileGateError,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  CopyButton,
  LoadingOverlay,
  styles,
} from './previewShared';
import { FileDownloadLink } from './FileDownloadLink';

interface Props {
  url: string;
  ext: string;
  path: string;
  agentId: string;
  root: string;
}

const CSV_PREVIEW_ROWS = 100;

function detectDelimiter(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 5);
  if (lines.length === 0) return fallback;
  const candidates = [',', '\t', ';', '|'];
  let best = fallback;
  let bestCount = 0;
  for (const d of candidates) {
    let total = 0;
    for (const line of lines) {
      let count = 0;
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuote = !inQuote;
        else if (ch === d && !inQuote) count++;
      }
      total += count;
    }
    if (total > bestCount) {
      bestCount = total;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === delim && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

export function CsvPreview({ url, ext, agentId, root, path }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.csv });
  const canLoad = !gate.sizeUnknown && !gate.error && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, cancel, retry } = useFetchText(url, canLoad);
  const [view, setView] = useState<'table' | 'raw'>('table');

  if (gate.sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking file size..." />
      </div>
    );
  }
  if (gate.error) return <FileGateError message={gate.error} onRetry={gate.retry} />;
  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="CSV"
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
        <LoadingOverlay message="Loading CSV..." onCancel={cancel} />
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
  const allLines = raw.split(/\r?\n/);
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  const actualTotal = allLines.length;
  const previewLines = allLines.slice(0, CSV_PREVIEW_ROWS);
  const isTruncated = actualTotal > CSV_PREVIEW_ROWS;
  const defaultDelim = ext === 'tsv' ? '\t' : ',';
  const delim = detectDelimiter(raw, defaultDelim);
  const delimLabel = delim === '\t' ? 'tab' : delim;

  const rows = previewLines.map((line) => splitCsvLine(line, delim));
  const header = rows[0] || [];
  const bodyRows = rows.slice(1);
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div style={styles.codeContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>
          {actualTotal.toLocaleString()} rows{isTruncated ? ` · showing first ${CSV_PREVIEW_ROWS}` : ''} · delim: {delimLabel}
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
        }}>{previewLines.join('\n')}{isTruncated ? '\n\n... (truncated)' : ''}</pre>
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
