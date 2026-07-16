import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import type { FsEntry } from '../api/client';
import { font } from '../theme';
import { useIsMobile } from '../state/useIsMobile';
import {
  FILE_LIST_ROW_HEIGHT_DESKTOP,
  FILE_LIST_ROW_HEIGHT_MOBILE,
  fileListStyles,
  formatDate,
  formatDateShort,
  formatSize,
  getEntryIcon,
  isRecentlyModified,
  useFileListLayout,
  type FileListSortKey,
} from './fileListShared';

export interface FileEntryListRowModel {
  entry: FsEntry;
  /** Clipboard + tooltip path (root + relative path for collections). */
  fullPath: string;
  rootLabel?: string;
  /** Missing/unopenable rows — same affordance as denied (dimmed, no click). */
  unavailable?: boolean;
  /** Caller-specific payload (e.g. CollectionItem). */
  data?: unknown;
}

export interface FileEntryListProps {
  rows: FileEntryListRowModel[];
  sortBy: FileListSortKey;
  sortAsc: boolean;
  onToggleSort: (key: FileListSortKey) => void;
  showRootColumn?: boolean;
  emptyMessage?: string;
  onRowClick: (row: FileEntryListRowModel, index: number) => void;
  /** Extra icon buttons in the name cell on hover, before "Copy full path". */
  renderNameHoverActions?: (row: FileEntryListRowModel, index: number) => ReactNode;
}

function useCopyToClipboard() {
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(label);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedPath(label);
      setTimeout(() => setCopiedPath(null), 2000);
    }
  }, []);
  return { copiedPath, copyToClipboard };
}

function useRecentEntryClock(entries: FsEntry[]) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [entries]);
  const hasRecent = useMemo(
    () => entries.some((e) => isRecentlyModified(e.modified, nowMs)),
    [entries, nowMs],
  );
  useEffect(() => {
    if (!hasRecent) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [hasRecent]);
  return nowMs;
}

function CopyPathButton({
  copied,
  onCopy,
}: {
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy();
      }}
      style={fileListStyles.copyNameBtn}
      title="Copy full path"
    >
      {copied ? (
        <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <path d="M6 8h4M6 10.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      )}
    </button>
  );
}

export interface FileEntryListRowProps {
  style: CSSProperties;
  index: number;
  row: FileEntryListRowModel;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  gridTemplateColumns: string;
  hoverNamePad: number;
  isMobile: boolean;
  nowMs: number;
  showRootColumn: boolean;
  copiedPath: string | null;
  copyToClipboard: (text: string, label: string) => void;
  nameAlignRight?: boolean;
  fileNameSerif?: boolean;
  renderNameHoverActions?: (row: FileEntryListRowModel, index: number) => ReactNode;
}

/** Single file row — shared by FileBrowser and Collections. */
export function FileEntryListRow({
  style,
  index,
  row,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onClick,
  gridTemplateColumns,
  hoverNamePad,
  isMobile,
  nowMs,
  showRootColumn,
  copiedPath,
  copyToClipboard,
  nameAlignRight = false,
  fileNameSerif = false,
  renderNameHoverActions,
}: FileEntryListRowProps) {
  const { entry, fullPath, rootLabel, unavailable } = row;
  const blocked = entry.denied || unavailable;
  const isRecent = !blocked && isRecentlyModified(entry.modified, nowMs);
  const copyLabel = `path-${index}`;
  const showHoverActions = isHovered && !blocked;
  const nameHoverPad = showHoverActions ? hoverNamePad : 0;

  return (
    <div
      style={{
        ...style,
        ...fileListStyles.entry,
        gridTemplateColumns,
        ...(isHovered ? fileListStyles.entryHover : {}),
        opacity: blocked ? 0.4 : 1,
        cursor: blocked ? 'not-allowed' : 'pointer',
      }}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span style={fileListStyles.icon}>{getEntryIcon(entry)}</span>
      <div style={fileListStyles.entryNameCell}>
        <span
          style={{
            ...fileListStyles.entryName,
            fontFamily: fileNameSerif ? font.serif : font.sans,
            ...(nameAlignRight ? { direction: 'rtl', textAlign: 'right' } : {}),
            ...(nameHoverPad ? { paddingRight: nameHoverPad } : {}),
          }}
          title={fullPath}
        >
          {nameAlignRight ? <bdi dir="ltr">{entry.name}</bdi> : entry.name}
        </span>
        {entry.denied && <span style={fileListStyles.deniedBadge}>denied</span>}
        {showHoverActions && (
          <span style={fileListStyles.entryNameHoverActions}>
            {renderNameHoverActions?.(row, index)}
            <CopyPathButton
              copied={copiedPath === copyLabel}
              onCopy={() => copyToClipboard(fullPath, copyLabel)}
            />
          </span>
        )}
      </div>
      {showRootColumn && (
        <span style={fileListStyles.entrySource} title={fullPath}>
          {rootLabel ?? '—'}
        </span>
      )}
      <span
        style={{
          ...(isMobile ? fileListStyles.entryDateMobile : fileListStyles.entryDate),
          ...(entry.modified && isRecent ? fileListStyles.entryDateRecent : {}),
        }}
        title={
          entry.modified
            ? (isMobile ? formatDateShort(entry.modified) : formatDate(entry.modified))
            : undefined
        }
      >
        {entry.modified
          ? (isMobile ? formatDateShort(entry.modified) : formatDate(entry.modified))
          : '—'}
      </span>
      {!isMobile && (
        <span style={fileListStyles.entryMeta}>
          {entry.size !== null ? formatSize(entry.size) : '—'}
        </span>
      )}
    </div>
  );
}

interface RowItemData {
  rows: FileEntryListRowModel[];
  hoveredIdx: number | null;
  setHoveredIdx: (idx: number | null) => void;
  gridTemplateColumns: string;
  hoverNamePad: number;
  isMobile: boolean;
  nowMs: number;
  showRootColumn: boolean;
  copiedPath: string | null;
  copyToClipboard: (text: string, label: string) => void;
  onRowClick: (row: FileEntryListRowModel, index: number) => void;
  renderNameHoverActions?: (row: FileEntryListRowModel, index: number) => ReactNode;
}

const VirtualRow = ({ index, style, data }: ListChildComponentProps<RowItemData>) => {
  const {
    rows,
    hoveredIdx,
    setHoveredIdx,
    gridTemplateColumns,
    hoverNamePad,
    isMobile,
    nowMs,
    showRootColumn,
    copiedPath,
    copyToClipboard,
    onRowClick,
    renderNameHoverActions,
  } = data;
  const row = rows[index];
  const blocked = row.entry.denied || row.unavailable;

  return (
    <FileEntryListRow
      style={style}
      index={index}
      row={row}
      isHovered={hoveredIdx === index}
      onMouseEnter={() => setHoveredIdx(index)}
      onMouseLeave={() => setHoveredIdx(null)}
      onClick={() => {
        if (!blocked) onRowClick(row, index);
      }}
      gridTemplateColumns={gridTemplateColumns}
      hoverNamePad={hoverNamePad}
      isMobile={isMobile}
      nowMs={nowMs}
      showRootColumn={showRootColumn}
      copiedPath={copiedPath}
      copyToClipboard={copyToClipboard}
      renderNameHoverActions={renderNameHoverActions}
    />
  );
};

export function FileEntryList({
  rows,
  sortBy,
  sortAsc,
  onToggleSort,
  showRootColumn = false,
  emptyMessage = 'Empty',
  onRowClick,
  renderNameHoverActions,
}: FileEntryListProps) {
  const isMobile = useIsMobile();
  const rowHeight = isMobile ? FILE_LIST_ROW_HEIGHT_MOBILE : FILE_LIST_ROW_HEIGHT_DESKTOP;
  const containerRef = useRef<HTMLDivElement>(null);
  const { copiedPath, copyToClipboard } = useCopyToClipboard();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const entries = useMemo(() => rows.map((r) => r.entry), [rows]);
  const nowMs = useRecentEntryClock(entries);
  const extraHoverActions = renderNameHoverActions ? 2 : 0;
  const {
    gridTemplateColumns,
    bodyHeight,
    padRight,
    outerElementType,
    hoverNamePad,
  } = useFileListLayout(containerRef, {
    showRootColumn,
    isMobile,
    rows,
    hasRows: rows.length > 0,
    extraHoverActions,
  });

  const sortIndicator = (key: FileListSortKey) => {
    if (sortBy !== key) return '';
    return sortAsc ? ' ↑' : ' ↓';
  };

  const rowItemData = useMemo<RowItemData>(
    () => ({
      rows,
      hoveredIdx,
      setHoveredIdx,
      gridTemplateColumns,
      hoverNamePad,
      isMobile,
      nowMs,
      showRootColumn,
      copiedPath,
      copyToClipboard,
      onRowClick,
      renderNameHoverActions,
    }),
    [
      rows, hoveredIdx, gridTemplateColumns, hoverNamePad, isMobile, nowMs, showRootColumn,
      copiedPath, copyToClipboard, onRowClick, renderNameHoverActions,
    ],
  );

  return (
    <div ref={containerRef} style={{ ...fileListStyles.listContainer, flex: 1, minHeight: 0 }}>
      <div style={{
        ...fileListStyles.colHeader,
        gridTemplateColumns,
        paddingRight: 12 + padRight,
      }}>
        <span style={fileListStyles.colIcon} />
        <span
          style={{ ...fileListStyles.colName, cursor: 'pointer' }}
          onClick={() => onToggleSort('name')}
        >
          Name{sortIndicator('name')}
        </span>
        {showRootColumn && (
          <span
            style={{ ...fileListStyles.colSource, cursor: 'pointer' }}
            onClick={() => onToggleSort('root')}
          >
            Root{sortIndicator('root')}
          </span>
        )}
        <span
          style={{ ...fileListStyles.colDate, cursor: 'pointer' }}
          onClick={() => onToggleSort('modified')}
        >
          Modified{sortIndicator('modified')}
        </span>
        {!isMobile && (
          <span
            style={{ ...fileListStyles.colSize, cursor: 'pointer' }}
            onClick={() => onToggleSort('size')}
          >
            Size{sortIndicator('size')}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div style={fileListStyles.empty}>{emptyMessage}</div>
      ) : (
        <FixedSizeList
          height={bodyHeight}
          itemCount={rows.length}
          itemSize={rowHeight}
          itemData={rowItemData}
          width="100%"
          outerElementType={outerElementType}
        >
          {VirtualRow}
        </FixedSizeList>
      )}
    </div>
  );
}
