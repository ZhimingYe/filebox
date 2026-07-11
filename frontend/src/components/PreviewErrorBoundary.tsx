import { Component, type ErrorInfo, type ReactNode } from 'react';
import { c, radius } from '../theme';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// A preview can fail while rendering or while a lazy viewer chunk is loading.
// Keep that failure inside the active preview instead of unmounting the app.
export class PreviewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Preview failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={styles.container} role="alert">
        <div style={styles.errorBox}>
          <p style={styles.title}>Preview failed</p>
          <p style={styles.message}>
            {this.state.error.message || 'The file could not be previewed.'}
          </p>
          <button
            style={styles.retryBtn}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20, background: c.bgSubtle,
  },
  errorBox: {
    width: '100%', maxWidth: 480, padding: '16px 18px',
    border: `1px solid ${c.danger}20`, borderRadius: radius.md,
    background: c.dangerBg, color: c.danger,
  },
  title: { margin: '0 0 6px', fontSize: 14, fontWeight: 600 },
  message: { margin: '0 0 12px', fontSize: 13, lineHeight: 1.5 },
  retryBtn: {
    padding: '6px 14px', border: `1px solid ${c.danger}`,
    borderRadius: radius.md, background: 'transparent', color: c.danger,
    cursor: 'pointer', fontSize: 12,
  },
};
