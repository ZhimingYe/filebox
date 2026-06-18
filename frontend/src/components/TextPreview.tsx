import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import {
  useFetchText,
  useFileGate,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  CopyButton,
  LoadingOverlay,
  wrapPref,
  setWrapPref,
  extToLang,
  styles,
} from './previewShared';

interface Props {
  url: string;
  ext: string;
  agentId: string;
  root: string;
  path: string;
}

export function TextPreview({ url, ext, agentId, root, path }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.text });
  const { text, error, loading, cancel, retry } = useFetchText(url);
  const [wrap, setWrap] = useState(wrapPref);

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
        flavor="file"
        onForceLoad={gate.forceLoad}
        url={url}
      />
    );
  }

  const toggleWrap = () => {
    const next = !wrap;
    setWrapPref(next);
    setWrap(next);
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading file..." onCancel={cancel} />
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

  const raw = text!;
  const totalLines = raw.split('\n').length;
  const isLarge = raw.length > 100000;
  const displayText = isLarge ? raw.slice(0, 100000) + '\n... (truncated)' : raw;
  const lang = extToLang[ext] || 'text';

  return (
    <div style={styles.codeContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>
          {totalLines.toLocaleString()} lines · {raw.length.toLocaleString()} chars{isLarge ? ' · truncated' : ''}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={toggleWrap} style={styles.toolBtn}>
            {wrap ? 'Wrap: On' : 'Wrap: Off'}
          </button>
          <CopyButton text={raw} />
        </div>
      </div>
      {isLarge ? (
        <pre style={{
          ...styles.code,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          wordBreak: wrap ? 'break-all' : 'normal',
        }}>{displayText}</pre>
      ) : (
        <div className={wrap ? 'code-transparent code-wrap' : 'code-transparent'}>
          <SyntaxHighlighter
            language={lang}
            style={oneLight}
            showLineNumbers
            customStyle={{
              margin: 0,
              padding: '16px',
              background: 'transparent',
              fontSize: 13,
              lineHeight: 1.5,
              overflowX: wrap ? 'hidden' : 'auto',
              minWidth: 0,
            }}
          >
            {displayText}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
}
