import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { c } from '../theme';

interface Props {
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  /** When false, the list panel expands to full width (no preview column). */
  showPreview: boolean;
  list: ReactNode;
  preview: ReactNode;
  containerRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}

/**
 * Shared list + draggable splitter + preview layout used by Files and Collections.
 * Split ratio is owned by the parent (typically persisted in App via localStorage).
 */
export function WorkspaceSplit({
  splitRatio,
  onSplitRatioChange,
  showPreview,
  list,
  preview,
  containerRef,
  style,
}: Props) {
  const internalRef = useRef<HTMLDivElement>(null);
  const container = containerRef ?? internalRef;
  const [splitterHover, setSplitterHover] = useState(false);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = container.current;
    if (!el) return;
    let rafId: number | null = null;
    let lastClientX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      lastClientX = ev.clientX;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const rect = el.getBoundingClientRect();
        const ratio = (lastClientX - rect.left) / rect.width;
        onSplitRatioChange(Math.max(0.2, Math.min(0.8, ratio)));
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.body.classList.remove('split-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.classList.add('split-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [container, onSplitRatioChange]);

  return (
    <div ref={container as RefObject<HTMLDivElement>} style={{ ...styles.root, ...style }}>
      <div
        style={{
          ...styles.listPanel,
          flex: showPreview ? `0 0 ${splitRatio * 100}%` : '1',
        }}
      >
        {list}
      </div>
      {showPreview && (
        <>
          <div
            onMouseDown={startSplitDrag}
            onMouseEnter={() => setSplitterHover(true)}
            onMouseLeave={() => setSplitterHover(false)}
            style={{ ...styles.splitter, ...(splitterHover ? styles.splitterHover : {}) }}
            title="Drag to resize"
          />
          <div style={styles.previewPanel}>
            {preview}
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0, minHeight: 0,
  },
  listPanel: {
    minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  splitter: {
    width: 4, cursor: 'col-resize', background: c.border,
    flexShrink: 0, transition: 'background 0.15s',
  },
  splitterHover: {
    background: c.accent,
  },
  previewPanel: {
    flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
};
