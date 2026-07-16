import { useCallback, useEffect, useRef, useState } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import type { CollectionItem } from '../api/client';
import { c } from '../theme';
import { IconClose } from './icons';
import {
  entryFromBasename,
  fileListStyles,
  formatSize,
  getEntryIcon,
} from './fileListShared';

const ROW_HEIGHT = 36;
const COL_HEADER_HEIGHT = 28;

export type CollectionItemStatus = 'ok' | 'missing' | 'denied' | 'unknown';

export interface CollectionItemRow {
  item: CollectionItem;
  name: string;
  status: CollectionItemStatus;
  size?: number | null;
}

interface CollectionItemListProps {
  rows: CollectionItemRow[];
  selectedKey: string | null;
  onSelect: (row: CollectionItemRow) => void;
  onOpenInFiles: (row: CollectionItemRow) => void;
  onRemove: (row: CollectionItemRow) => void;
}

function itemKey(item: CollectionItem): string {
  return `${item.root}::${item.path}`;
}

export function CollectionItemList({
  rows,
  selectedKey,
  onSelect,
  onOpenInFiles,
  onRemove,
}: CollectionItemListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const obs = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setListHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, []);

  const Row = useCallback(
    ({ index, style }: ListChildComponentProps) => {
      const row = rows[index];
      const { item, name, status } = row;
      const key = itemKey(item);
      const entry = entryFromBasename(name);
      const selected = selectedKey === key;
      const hovered = hoveredKey === key;
      const muted = status === 'missing' || status === 'denied';

      return (
        <div
          style={{
            ...style,
            ...fileListStyles.entry,
            ...(selected ? fileListStyles.entryActive : {}),
            ...(hovered && !selected ? fileListStyles.entryHover : {}),
            opacity: muted ? 0.55 : 1,
            cursor: status === 'missing' ? 'default' : 'pointer',
          }}
          onClick={() => onSelect(row)}
          onMouseEnter={() => setHoveredKey(key)}
          onMouseLeave={() => setHoveredKey(null)}
        >
          <span style={fileListStyles.icon}>{getEntryIcon(entry)}</span>
          <div style={fileListStyles.entryNameCell}>
            <span style={fileListStyles.entryName} title={item.path}>
              {name}
            </span>
            {status === 'denied' && <span style={fileListStyles.deniedBadge}>denied</span>}
            {status === 'missing' && <span style={fileListStyles.missingBadge}>not found</span>}
          </div>
          <span style={fileListStyles.entrySource} title={item.path}>
            {item.root}
          </span>
          <span style={fileListStyles.entryMeta}>
            {row.size != null ? formatSize(row.size) : '—'}
          </span>
          <span style={{ display: 'flex', gap: 2, width: 52, flexShrink: 0, justifyContent: 'flex-end' }}>
            {hovered && (
              <>
                <button
                  type="button"
                  title="Open in Files"
                  style={fileListStyles.rowActionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInFiles(row);
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = c.accent; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = c.textMuted; }}
                >
                  <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="currentColor"/>
                  </svg>
                </button>
                <button
                  type="button"
                  title="Remove from collection"
                  style={fileListStyles.rowActionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(row);
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = c.danger; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = c.textMuted; }}
                >
                  <IconClose style={{ width: 12, height: 12 }} />
                </button>
              </>
            )}
          </span>
        </div>
      );
    },
    [rows, selectedKey, hoveredKey, onSelect, onOpenInFiles, onRemove],
  );

  if (rows.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: c.textMuted,
          fontSize: 13,
          padding: 16,
        }}
      >
        Empty collection — add files from the Files browser.
      </div>
    );
  }

  const bodyHeight = Math.max(0, listHeight - COL_HEADER_HEIGHT);

  return (
    <div ref={containerRef} style={{ ...fileListStyles.listContainer, flex: 1, minHeight: 0 }}>
      <div style={fileListStyles.colHeader}>
        <span style={fileListStyles.colIcon} />
        <span style={fileListStyles.colName}>Name</span>
        <span style={fileListStyles.colSource}>Root</span>
        <span style={fileListStyles.colSize}>Size</span>
        <span style={{ width: 52, flexShrink: 0 }} />
      </div>
      <FixedSizeList
        height={bodyHeight}
        itemCount={rows.length}
        itemSize={ROW_HEIGHT}
        width="100%"
      >
        {Row}
      </FixedSizeList>
    </div>
  );
}
