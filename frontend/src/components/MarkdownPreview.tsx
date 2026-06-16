import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  useFetchText,
  CopyButton,
  LoadingOverlay,
  styles,
} from './previewShared';

interface Props {
  url: string;
}

export function MarkdownPreview({ url }: Props) {
  const { text, error, loading, cancel, retry } = useFetchText(url);

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading markdown..." onCancel={cancel} />
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
  const isTruncated = raw.length > 500000;
  const displayText = isTruncated ? raw.slice(0, 500000) + '\n\n---\n*File truncated*' : raw;

  return (
    <div style={styles.markdownContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>{raw.length.toLocaleString()} chars{isTruncated ? ' · truncated' : ''}</span>
        <CopyButton text={raw} />
      </div>
      <div className="markdown" style={{ ...styles.markdown, marginTop: 0 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
      </div>
    </div>
  );
}
