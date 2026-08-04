import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import * as api from '../api/client';
import type { FsEntry, RootInfo } from '../api/client';
import { retryAsync, throwIfAgentError } from '../api/retry';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useIsMobile } from '../state/useIsMobile';
import { c, font, radius } from '../theme';
import { getEntryIcon, IconFolder } from './fileListShared';
import { IconPin } from './icons';

interface Props {
  agentId: string;
  roots: RootInfo[];
  active: boolean;
  onFileSelect: (root: string, path: string, entry: FsEntry) => void;
  onAddToCollection?: (root: string, path: string, anchor: HTMLElement) => void;
  onRootsChange?: () => void | Promise<void>;
}

interface DirectoryState {
  items: FsEntry[];
  nextCursor: string | null;
  loading: boolean;
  loadPhase: 'queued' | 'loading' | 'slow' | null;
  loadMode: 'replace' | 'append' | null;
  loaded: boolean;
  error: string | null;
  errorAppend: boolean;
  lastUsed: number;
}

interface LoadTask {
  key: string;
  root: string;
  path: string;
  cursor?: string;
  append: boolean;
  seq: number;
}

type ExplorerRow =
  | {
      kind: 'node';
      id: string;
      root: string;
      path: string;
      fullPath: string;
      label: string;
      depth: number;
      isRoot: boolean;
      isDirectory: boolean;
      denied: boolean;
      expanded: boolean;
      loading: boolean;
      entry?: FsEntry;
    }
  | {
      kind: 'message';
      id: string;
      root: string;
      parentPath: string;
      depth: number;
      message: string;
      retryable: boolean;
      append: boolean;
    }
  | {
      kind: 'loading';
      id: string;
      root: string;
      parentPath: string;
      depth: number;
      message: string;
    }
  | {
      kind: 'load-more';
      id: string;
      root: string;
      parentPath: string;
      depth: number;
      loading: boolean;
    };

type ExplorerSortKey = 'name' | 'modified';

const PAGE_LIMIT = 200;
const MAX_EXPANDED_DIRECTORIES = 32;
const MAX_CACHED_DIRECTORIES = 64;
const MAX_CACHED_ENTRIES = 20_000;
const MAX_CONCURRENT_LOADS = 2;
const SLOW_DIRECTORY_LOAD_MS = 8_000;
const DIRECTORY_LOAD_TIMEOUT_MS = 35_000;
const EXPLORER_SORT_KEY_STORAGE = 'filebox.explorerSortKey';
const EXPLORER_SORT_ASC_STORAGE = 'filebox.explorerSortAsc';
const FILE_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});
const SORTED_ENTRIES_CACHE = new WeakMap<
  FsEntry[],
  Map<string, FsEntry[]>
>();
const APPENDED_ENTRIES = new WeakMap<
  FsEntry[],
  { previous: FsEntry[]; appended: FsEntry[] }
>();
const MODIFIED_TIME_CACHE = new WeakMap<FsEntry, number>();

function directoryErrorMessage(error: unknown): string {
  const friendly = api.friendlyMessage(error);
  if (friendly !== 'An unexpected error occurred.') return friendly;
  if (error instanceof Error && error.message) {
    if (/failed to fetch|load failed|networkerror|network request failed/i.test(error.message)) {
      return 'Network connection was interrupted. Check the connection and retry.';
    }
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof error.message === 'string'
    && error.message.trim()
  ) {
    return error.message;
  }
  return 'Failed to load folder.';
}

const EMPTY_DIRECTORY: DirectoryState = {
  items: [],
  nextCursor: null,
  loading: false,
  loadPhase: null,
  loadMode: null,
  loaded: false,
  error: null,
  errorAppend: false,
  lastUsed: 0,
};

function nodeKey(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

function splitNodeKey(key: string): { root: string; path: string } {
  const split = key.indexOf('\u0000');
  return { root: key.slice(0, split), path: key.slice(split + 1) };
}

function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function displayPath(rootPath: string, relativePath: string): string {
  const base = rootPath.replace(/\/+$/, '');
  return relativePath === '/' ? base || '/' : `${base}${relativePath}`;
}

function normalizePinPath(path: string): string {
  let normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return normalized || '/';
}

function isPendingAgentUpdate(value: unknown): boolean {
  return (
    typeof value === 'object'
    && value !== null
    && 'state' in value
    && value.state === 'pending_agent_reconnect'
  );
}

function compareExplorerEntries(
  a: FsEntry,
  b: FsEntry,
  sortBy: ExplorerSortKey,
  sortAsc: boolean,
): number {
  const aDirectory = a.entry_type === 'directory';
  const bDirectory = b.entry_type === 'directory';
  if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;

  let comparison = 0;
  if (sortBy === 'modified') {
    const aTime = modifiedTime(a);
    const bTime = modifiedTime(b);
    const aHasTime = Number.isFinite(aTime);
    const bHasTime = Number.isFinite(bTime);
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    if (aHasTime && bHasTime) comparison = aTime - bTime;
  } else {
    comparison = FILE_NAME_COLLATOR.compare(a.name, b.name);
  }

  if (comparison !== 0) return sortAsc ? comparison : -comparison;
  return FILE_NAME_COLLATOR.compare(a.name, b.name);
}

function modifiedTime(entry: FsEntry): number {
  const cached = MODIFIED_TIME_CACHE.get(entry);
  if (cached !== undefined) return cached;
  const parsed = entry.modified ? Date.parse(entry.modified) : Number.NaN;
  MODIFIED_TIME_CACHE.set(entry, parsed);
  return parsed;
}

function mergeSortedEntries(
  left: FsEntry[],
  right: FsEntry[],
  sortBy: ExplorerSortKey,
  sortAsc: boolean,
): FsEntry[] {
  const merged: FsEntry[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (
      compareExplorerEntries(
        left[leftIndex],
        right[rightIndex],
        sortBy,
        sortAsc,
      ) <= 0
    ) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
    } else {
      merged.push(right[rightIndex]);
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length) merged.push(...left.slice(leftIndex));
  if (rightIndex < right.length) merged.push(...right.slice(rightIndex));
  return merged;
}

function sortedExplorerEntries(
  items: FsEntry[],
  sortBy: ExplorerSortKey,
  sortAsc: boolean,
): FsEntry[] {
  const cacheKey = `${sortBy}:${sortAsc ? 'asc' : 'desc'}`;
  const cached = SORTED_ENTRIES_CACHE.get(items)?.get(cacheKey);
  if (cached) return cached;

  const append = APPENDED_ENTRIES.get(items);
  const sorted = append
    ? mergeSortedEntries(
        sortedExplorerEntries(append.previous, sortBy, sortAsc),
        sortedExplorerEntries(append.appended, sortBy, sortAsc),
        sortBy,
        sortAsc,
      )
    : [...items].sort(
        (a, b) => compareExplorerEntries(a, b, sortBy, sortAsc),
      );
  if (append) APPENDED_ENTRIES.delete(items);
  const itemCache = SORTED_ENTRIES_CACHE.get(items) ?? new Map<string, FsEntry[]>();
  itemCache.set(cacheKey, sorted);
  SORTED_ENTRIES_CACHE.set(items, itemCache);
  return sorted;
}

function appendExplorerEntries(existing: FsEntry[], appended: FsEntry[]): FsEntry[] {
  const combined = [...existing, ...appended];
  APPENDED_ENTRIES.set(combined, { previous: existing, appended });
  return combined;
}

function isSameOrDescendant(
  candidateKey: string,
  root: string,
  path: string,
): boolean {
  const candidate = splitNodeKey(candidateKey);
  if (candidate.root !== root) return false;
  if (candidate.path === path) return true;
  return path === '/'
    ? candidate.path.startsWith('/')
    : candidate.path.startsWith(`${path}/`);
}

function totalCachedEntries(nodes: Map<string, DirectoryState>): number {
  let total = 0;
  nodes.forEach((state) => {
    total += state.items.length;
  });
  return total;
}

function trimCollapsedCache(
  nodes: Map<string, DirectoryState>,
  expanded: Set<string>,
): Map<string, DirectoryState> {
  let totalEntries = totalCachedEntries(nodes);
  while (
    nodes.size > MAX_CACHED_DIRECTORIES
    || totalEntries > MAX_CACHED_ENTRIES
  ) {
    let candidate: { key: string; state: DirectoryState } | null = null;
    nodes.forEach((state, key) => {
      if (expanded.has(key)) return;
      if (!candidate || state.lastUsed < candidate.state.lastUsed) {
        candidate = { key, state };
      }
    });
    if (!candidate) break;
    const evicted = candidate as { key: string; state: DirectoryState };
    nodes.delete(evicted.key);
    totalEntries -= evicted.state.items.length;
  }
  return nodes;
}

export function ExplorerView({
  agentId,
  roots,
  active,
  onFileSelect,
  onAddToCollection,
  onRootsChange,
}: Props) {
  const isMobile = useIsMobile();
  const rowHeight = isMobile ? 38 : 30;
  const rootsSignature = JSON.stringify(roots.map((root) => [
    root.name,
    root.path_display,
    root.enabled,
    root.pinned_folders,
  ]));
  const enabledRoots = useMemo(
    () => roots.filter((root) => root.enabled),
    // Agent RTT/telemetry refreshes replace the roots array even when its
    // Explorer-visible structure is identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsSignature],
  );
  const [nodes, setNodes] = useState<Map<string, DirectoryState>>(new Map());
  const nodesRef = useRef(nodes);
  const firstRootKey = enabledRoots[0] ? nodeKey(enabledRoots[0].name, '/') : null;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => firstRootKey ? new Set([firstRootKey]) : new Set(),
  );
  const expandedRef = useRef(expanded);
  const [selectedId, setSelectedId] = useState<string | null>(firstRootKey);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<ExplorerSortKey>(() => {
    try {
      return localStorage.getItem(EXPLORER_SORT_KEY_STORAGE) === 'modified'
        ? 'modified'
        : 'name';
    } catch {
      return 'name';
    }
  });
  const [sortAsc, setSortAsc] = useState(() => {
    try {
      return localStorage.getItem(EXPLORER_SORT_ASC_STORAGE) !== '0';
    } catch {
      return true;
    }
  });
  const [pinBusyIds, setPinBusyIds] = useState<Set<string>>(new Set());
  const pinBusyRef = useRef<Set<string>>(new Set());
  const pinQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const [viewportHeight, setViewportHeight] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList>(null);
  const mountedRef = useRef(true);
  const usageTickRef = useRef(0);
  const requestSeqRef = useRef(0);
  const scheduledRef = useRef<Map<string, number>>(new Map());
  const queueRef = useRef<LoadTask[]>([]);
  const activeRef = useRef<Map<string, { controller: AbortController; seq: number }>>(new Map());
  const reservedEntriesRef = useRef<Map<number, number>>(new Map());
  const refreshSeqsRef = useRef<Set<number>>(new Set());
  const refreshFailedRef = useRef(false);
  const refreshCancelledRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  const { copiedPath, copyToClipboard } = useCopyToClipboard();
  useEffect(() => {
    try {
      localStorage.setItem(EXPLORER_SORT_KEY_STORAGE, sortBy);
      localStorage.setItem(EXPLORER_SORT_ASC_STORAGE, sortAsc ? '1' : '0');
    } catch {
      // Storage may be unavailable in hardened/private browser contexts.
    }
  }, [sortAsc, sortBy]);

  const pinnedIds = useMemo(() => {
    const ids = new Set<string>();
    roots.forEach((root) => {
      root.pinned_folders.forEach((path) => {
        ids.add(nodeKey(root.name, normalizePinPath(path)));
      });
    });
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsSignature]);

  const showNotice = useCallback((
    message: string | null,
    autoDismissMs?: number,
  ) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(message);
    if (message && autoDismissMs) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, autoDismissMs);
    }
  }, []);

  const finishRefreshTask = useCallback((
    seq: number,
    result: 'success' | 'failed' | 'cancelled',
  ) => {
    if (!refreshSeqsRef.current.delete(seq)) return;
    if (result === 'failed') refreshFailedRef.current = true;
    if (result === 'cancelled') refreshCancelledRef.current = true;
    if (refreshSeqsRef.current.size > 0 || !mountedRef.current) return;

    if (refreshCancelledRef.current) {
      showNotice('Refresh cancelled. Retry when ready.', 2_500);
    } else if (refreshFailedRef.current) {
      showNotice('Refresh finished with errors. Use Retry on the affected folder.', 4_000);
    } else {
      showNotice('Refresh complete.', 1_800);
    }
  }, [showNotice]);

  const updateNodes = useCallback((
    updater: (previous: Map<string, DirectoryState>) => Map<string, DirectoryState>,
  ) => {
    setNodes((previous) => {
      const next = updater(previous);
      nodesRef.current = next;
      return next;
    });
  }, []);

  const startTask = useCallback((task: LoadTask) => {
    const controller = new AbortController();
    let result: 'success' | 'failed' | 'cancelled' = 'success';
    let timedOut = false;
    activeRef.current.set(task.key, { controller, seq: task.seq });
    updateNodes((previous) => {
      const next = new Map(previous);
      const existing = previous.get(task.key) ?? EMPTY_DIRECTORY;
      next.set(task.key, {
        ...existing,
        loadPhase: 'loading',
        loadMode: task.append ? 'append' : 'replace',
      });
      return next;
    });

    const slowTimer = window.setTimeout(() => {
      if (
        !mountedRef.current
        || scheduledRef.current.get(task.key) !== task.seq
      ) return;
      updateNodes((previous) => {
        const next = new Map(previous);
        const existing = previous.get(task.key);
        if (existing?.loading) {
          next.set(task.key, { ...existing, loadPhase: 'slow' });
        }
        return next;
      });
    }, SLOW_DIRECTORY_LOAD_MS);
    const timeoutTimer = window.setTimeout(() => {
      if (scheduledRef.current.get(task.key) !== task.seq) return;
      timedOut = true;
      controller.abort();
    }, DIRECTORY_LOAD_TIMEOUT_MS);

    const setFailure = (message: string) => {
      updateNodes((previous) => {
        const next = new Map(previous);
        const existing = previous.get(task.key) ?? EMPTY_DIRECTORY;
        next.set(task.key, {
          ...existing,
          loading: false,
          loadPhase: null,
          loadMode: null,
          loaded: true,
          error: message,
          errorAppend: task.append,
          lastUsed: ++usageTickRef.current,
        });
        return next;
      });
    };

    void retryAsync(
      async () => throwIfAgentError(await api.fsList(
        agentId,
        task.root,
        task.path,
        PAGE_LIMIT,
        task.cursor,
        false,
        controller.signal,
      )),
      {
        maxAttempts: 3,
        agentId,
        signal: controller.signal,
      },
    ).then((data) => {
      if (timedOut) {
        result = 'failed';
        setFailure('Folder loading timed out. Check the connection and retry.');
        return;
      }
      if (
        !mountedRef.current
        || controller.signal.aborted
        || scheduledRef.current.get(task.key) !== task.seq
      ) {
        result = 'cancelled';
        return;
      }
      updateNodes((previous) => {
        const next = new Map(previous);
        const existing = previous.get(task.key) ?? EMPTY_DIRECTORY;
        next.set(task.key, {
          items: task.append
            ? appendExplorerEntries(existing.items, data.items)
            : data.items,
          nextCursor: data.next_cursor ?? null,
          loading: false,
          loadPhase: null,
          loadMode: null,
          loaded: true,
          error: null,
          errorAppend: false,
          lastUsed: ++usageTickRef.current,
        });
        return trimCollapsedCache(next, expandedRef.current);
      });
    }).catch((error: unknown) => {
      if (timedOut && mountedRef.current) {
        result = 'failed';
        setFailure('Folder loading timed out. Check the connection and retry.');
        return;
      }
      if (
        !mountedRef.current
        || controller.signal.aborted
        || (error as { name?: string })?.name === 'AbortError'
        || scheduledRef.current.get(task.key) !== task.seq
      ) {
        result = 'cancelled';
        return;
      }
      result = 'failed';
      setFailure(directoryErrorMessage(error));
    }).finally(() => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeoutTimer);
      reservedEntriesRef.current.delete(task.seq);
      const active = activeRef.current.get(task.key);
      if (active?.seq === task.seq) {
        activeRef.current.delete(task.key);
      }
      if (scheduledRef.current.get(task.key) === task.seq) {
        scheduledRef.current.delete(task.key);
      }
      finishRefreshTask(task.seq, result);
      pumpRef.current();
    });
  }, [agentId, finishRefreshTask, updateNodes]);

  const pumpQueue = useCallback(() => {
    while (
      activeRef.current.size < MAX_CONCURRENT_LOADS
      && queueRef.current.length > 0
    ) {
      const task = queueRef.current[0];
      if (scheduledRef.current.get(task.key) !== task.seq) {
        queueRef.current.shift();
        reservedEntriesRef.current.delete(task.seq);
        continue;
      }
      // A cancelled request for the same directory may still be unwinding.
      // Keep the replacement queued until that exact slot has been released.
      if (activeRef.current.has(task.key)) return;
      queueRef.current.shift();
      startTask(task);
    }
  }, [startTask]);
  useEffect(() => {
    pumpRef.current = pumpQueue;
  }, [pumpQueue]);

  const scheduleLoad = useCallback((
    root: string,
    path: string,
    append = false,
  ): number | null => {
    const key = nodeKey(root, path);
    if (scheduledRef.current.has(key)) return null;
    const existing = nodesRef.current.get(key) ?? EMPTY_DIRECTORY;
    const reserved = Array.from(reservedEntriesRef.current.values())
      .reduce((sum, count) => sum + count, 0);
    const reserveForTask = append || existing.items.length === 0
      ? PAGE_LIMIT
      : 0;
    if (
      totalCachedEntries(nodesRef.current)
      + reserved
      + reserveForTask
      > MAX_CACHED_ENTRIES
    ) {
      showNotice(
        `Explorer keeps at most ${MAX_CACHED_ENTRIES.toLocaleString()} cached items. `
        + 'Collapse folders before loading more.',
      );
      return null;
    }

    const seq = ++requestSeqRef.current;
    scheduledRef.current.set(key, seq);
    reservedEntriesRef.current.set(seq, reserveForTask);
    updateNodes((previous) => {
      const next = new Map(previous);
      next.set(key, {
        ...(previous.get(key) ?? EMPTY_DIRECTORY),
        loading: true,
        loadPhase: 'queued',
        loadMode: append ? 'append' : 'replace',
        error: null,
        errorAppend: false,
        lastUsed: ++usageTickRef.current,
      });
      return next;
    });
    queueRef.current.push({
      key,
      root,
      path,
      cursor: append ? existing.nextCursor ?? undefined : undefined,
      append,
      seq,
    });
    pumpRef.current();
    return seq;
  }, [showNotice, updateNodes]);

  const cancelLoads = useCallback((keys: Set<string>) => {
    if (keys.size === 0) return;
    queueRef.current = queueRef.current.filter((task) => {
      if (!keys.has(task.key)) return true;
      reservedEntriesRef.current.delete(task.seq);
      if (scheduledRef.current.get(task.key) === task.seq) {
        scheduledRef.current.delete(task.key);
      }
      finishRefreshTask(task.seq, 'cancelled');
      return false;
    });
    keys.forEach((key) => {
      const active = activeRef.current.get(key);
      if (active) {
        if (scheduledRef.current.get(key) === active.seq) {
          scheduledRef.current.delete(key);
        }
        active.controller.abort();
      }
    });
    updateNodes((previous) => {
      const next = new Map(previous);
      keys.forEach((key) => {
        const state = next.get(key);
        if (state?.loading) {
          next.set(key, {
            ...state,
            loading: false,
            loadPhase: null,
            loadMode: null,
          });
        }
      });
      return next;
    });
    pumpRef.current();
  }, [finishRefreshTask, updateNodes]);

  const collapseDirectory = useCallback((root: string, path: string) => {
    const collapsedKeys = new Set<string>();
    expandedRef.current.forEach((key) => {
      if (isSameOrDescendant(key, root, path)) collapsedKeys.add(key);
    });
    const nextExpanded = new Set(expandedRef.current);
    collapsedKeys.forEach((key) => nextExpanded.delete(key));
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    setSelectedId(nodeKey(root, path));
    cancelLoads(collapsedKeys);
    updateNodes((previous) => (
      trimCollapsedCache(new Map(previous), nextExpanded)
    ));
  }, [cancelLoads, updateNodes]);

  const expandDirectory = useCallback((root: string, path: string) => {
    const key = nodeKey(root, path);
    if (expandedRef.current.has(key)) return;
    if (expandedRef.current.size >= MAX_EXPANDED_DIRECTORIES) {
      showNotice(
        `Explorer can keep ${MAX_EXPANDED_DIRECTORIES} folders expanded at once. `
        + 'Collapse a folder to continue.',
      );
      return;
    }
    const nextExpanded = new Set(expandedRef.current);
    nextExpanded.add(key);
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    const state = nodesRef.current.get(key);
    if (!state?.loaded && !state?.loading) {
      scheduleLoad(root, path);
    } else if (state) {
      updateNodes((previous) => {
        const next = new Map(previous);
        next.set(key, { ...state, lastUsed: ++usageTickRef.current });
        return next;
      });
    }
  }, [scheduleLoad, showNotice, updateNodes]);

  const toggleDirectory = useCallback((root: string, path: string) => {
    const key = nodeKey(root, path);
    if (expandedRef.current.has(key)) {
      collapseDirectory(root, path);
    } else {
      expandDirectory(root, path);
    }
  }, [collapseDirectory, expandDirectory]);

  const rows = useMemo<ExplorerRow[]>(() => {
    const flattened: ExplorerRow[] = [];
    const appendChildren = (root: RootInfo, path: string, depth: number) => {
      const key = nodeKey(root.name, path);
      const state = nodes.get(key) ?? EMPTY_DIRECTORY;
      if (state.loading && state.loadMode === 'replace') {
        const message = state.loadPhase === 'queued'
          ? 'Waiting to load…'
          : state.loadPhase === 'slow'
            ? 'Still loading this folder…'
            : 'Loading folder…';
        flattened.push({
          kind: 'loading',
          id: `loading:${key}`,
          root: root.name,
          parentPath: path,
          depth,
          message,
        });
      }
      const sortedItems = sortedExplorerEntries(state.items, sortBy, sortAsc);
      sortedItems.forEach((entry) => {
        const pathForEntry = childPath(path, entry.name);
        const id = nodeKey(root.name, pathForEntry);
        const directory = entry.entry_type === 'directory';
        flattened.push({
          kind: 'node',
          id,
          root: root.name,
          path: pathForEntry,
          fullPath: displayPath(root.path_display, pathForEntry),
          label: entry.name,
          depth,
          isRoot: false,
          isDirectory: directory,
          denied: entry.denied,
          expanded: directory && expanded.has(id),
          loading: directory && !!nodes.get(id)?.loading,
          entry,
        });
        if (directory && expanded.has(id)) {
          appendChildren(root, pathForEntry, depth + 1);
        }
      });
      if (state.error) {
        flattened.push({
          kind: 'message',
          id: `error:${key}`,
          root: root.name,
          parentPath: path,
          depth,
          message: state.error,
          retryable: true,
          append: state.errorAppend,
        });
      }
      if (state.nextCursor && !(state.error && state.errorAppend)) {
        flattened.push({
          kind: 'load-more',
          id: `more:${key}:${state.nextCursor}`,
          root: root.name,
          parentPath: path,
          depth,
          loading: state.loading && state.loadMode === 'append',
        });
      }
    };

    enabledRoots.forEach((root) => {
      const id = nodeKey(root.name, '/');
      flattened.push({
        kind: 'node',
        id,
        root: root.name,
        path: '/',
        fullPath: root.path_display,
        label: root.name,
        depth: 0,
        isRoot: true,
        isDirectory: true,
        denied: false,
        expanded: expanded.has(id),
        loading: !!nodes.get(id)?.loading,
      });
      if (expanded.has(id)) appendChildren(root, '/', 1);
    });
    return flattened;
  }, [enabledRoots, expanded, nodes, sortAsc, sortBy]);

  const nodeRows = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'node' ? [{ row, index }] : [])),
    [rows],
  );
  const selectedNode = useMemo(
    () => nodeRows.find(({ row }) => row.id === selectedId) ?? null,
    [nodeRows, selectedId],
  );

  const selectNodeAt = useCallback((index: number) => {
    const candidate = rows[index];
    if (!candidate || candidate.kind !== 'node') return;
    setSelectedId(candidate.id);
    listRef.current?.scrollToItem(index, 'smart');
  }, [rows]);

  const activateNode = useCallback((row: Extract<ExplorerRow, { kind: 'node' }>) => {
    setSelectedId(row.id);
    if (row.denied) return;
    if (row.isDirectory) {
      toggleDirectory(row.root, row.path);
    } else if (row.entry) {
      onFileSelect(row.root, row.path, row.entry);
    }
  }, [onFileSelect, toggleDirectory]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button') && !event.key.startsWith('Arrow')) return;
    const selectedPosition = selectedNode
      ? nodeRows.findIndex(({ row }) => row.id === selectedNode.row.id)
      : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextPosition = Math.max(
        0,
        Math.min(nodeRows.length - 1, selectedPosition === -1 ? 0 : selectedPosition + delta),
      );
      const next = nodeRows[nextPosition];
      if (next) selectNodeAt(next.index);
      return;
    }
    if (!selectedNode) return;
    const row = selectedNode.row;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateNode(row);
      return;
    }
    if (event.key === 'ArrowRight' && row.isDirectory) {
      event.preventDefault();
      if (!row.expanded) {
        expandDirectory(row.root, row.path);
      } else {
        const child = rows[selectedNode.index + 1];
        if (child?.kind === 'node' && child.depth === row.depth + 1) {
          selectNodeAt(selectedNode.index + 1);
        }
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.isDirectory && row.expanded) {
        collapseDirectory(row.root, row.path);
        return;
      }
      if (!row.isRoot) {
        const parentId = nodeKey(row.root, parentPath(row.path));
        const parentIndex = rows.findIndex(
          (candidate) => candidate.kind === 'node' && candidate.id === parentId,
        );
        if (parentIndex !== -1) selectNodeAt(parentIndex);
      }
    }
  }, [
    activateNode,
    collapseDirectory,
    expandDirectory,
    nodeRows,
    rows,
    selectNodeAt,
    selectedNode,
  ]);

  const handleCopy = useCallback(async (path: string, label: string) => {
    const copied = await copyToClipboard(path, label);
    if (!copied) {
      showNotice('Unable to copy the path. Check browser clipboard permission and retry.', 4_000);
    }
  }, [copyToClipboard, showNotice]);

  const handleCancelLoad = useCallback((root: string, path: string) => {
    cancelLoads(new Set([nodeKey(root, path)]));
    showNotice('Folder loading cancelled. You can expand or retry it again.', 2_500);
  }, [cancelLoads, showNotice]);

  const handlePin = useCallback(async (
    row: Extract<ExplorerRow, { kind: 'node' }>,
  ) => {
    if (!row.isDirectory || row.denied || pinBusyRef.current.has(row.id)) return;
    const pinned = pinnedIds.has(row.id);
    pinBusyRef.current.add(row.id);
    setPinBusyIds(new Set(pinBusyRef.current));
    const previous = pinQueuesRef.current.get(row.root);
    showNotice(
      previous
        ? `${pinned ? 'Unpin' : 'Pin'} for ${row.label} queued…`
        : `${pinned ? 'Unpinning' : 'Pinning'} ${row.label}…`,
    );
    const operation = (previous ?? Promise.resolve()).then(async () => {
      if (!mountedRef.current) return;
      showNotice(`${pinned ? 'Unpinning' : 'Pinning'} ${row.label}…`);
      try {
        const result = await api.patchRoot(agentId, row.root, pinned
          ? { pin_remove: normalizePinPath(row.path) }
          : { pin_add: normalizePinPath(row.path) });
        await onRootsChange?.();
        if (!mountedRef.current) return;
        if (isPendingAgentUpdate(result)) {
          showNotice(
            `${row.label} will be ${pinned ? 'unpinned' : 'pinned'} when the Agent reconnects.`,
            4_000,
          );
        } else {
          showNotice(`${row.label} ${pinned ? 'unpinned' : 'pinned'}.`, 1_800);
        }
      } catch (error: unknown) {
        if (!mountedRef.current) return;
        showNotice(
          `${pinned ? 'Unpin' : 'Pin'} failed: ${directoryErrorMessage(error)} `
          + 'Use the pin button to retry.',
          5_000,
        );
      } finally {
        pinBusyRef.current.delete(row.id);
        if (mountedRef.current) setPinBusyIds(new Set(pinBusyRef.current));
      }
    });
    pinQueuesRef.current.set(row.root, operation);
    try {
      await operation;
    } finally {
      if (pinQueuesRef.current.get(row.root) === operation) {
        pinQueuesRef.current.delete(row.root);
      }
    }
  }, [agentId, onRootsChange, pinnedIds, showNotice]);

  const refreshCurrentBranch = useCallback(() => {
    const fallbackRoot = enabledRoots[0];
    if (!fallbackRoot) return;
    const selected = selectedNode?.row;
    const root = selected?.root ?? fallbackRoot.name;
    const directory = selected
      ? (selected.isDirectory ? selected.path : parentPath(selected.path))
      : '/';
    const targets = [directory];
    const parent = parentPath(directory);
    if (parent !== directory) targets.push(parent);
    const sequences: number[] = [];
    targets.slice(0, 2).forEach((path) => {
      const seq = scheduleLoad(root, path);
      if (seq !== null) sequences.push(seq);
    });
    if (sequences.length > 0) {
      refreshFailedRef.current = false;
      refreshCancelledRef.current = false;
      sequences.forEach((seq) => refreshSeqsRef.current.add(seq));
      showNotice(
        `Refreshing ${sequences.length === 1 ? 'the selected folder' : 'the selected folder and its parent'}…`,
      );
      return;
    }
    const alreadyRefreshing = targets.some((path) => (
      scheduledRef.current.has(nodeKey(root, path))
    ));
    if (alreadyRefreshing) {
      showNotice('The selected branch is already refreshing.', 1_500);
    }
  }, [enabledRoots, scheduleLoad, selectedNode, showNotice]);

  const collapseAll = useCallback(() => {
    const allScheduled = new Set(scheduledRef.current.keys());
    expandedRef.current = new Set();
    setExpanded(new Set());
    cancelLoads(allScheduled);
    updateNodes((previous) => trimCollapsedCache(new Map(previous), new Set()));
    const firstRoot = enabledRoots[0];
    setSelectedId(firstRoot ? nodeKey(firstRoot.name, '/') : null);
    showNotice(null);
  }, [cancelLoads, enabledRoots, showNotice, updateNodes]);

  useEffect(() => {
    mountedRef.current = true;
    const scheduled = scheduledRef.current;
    const reservedEntries = reservedEntriesRef.current;
    const active = activeRef.current;
    const pinBusy = pinBusyRef.current;
    const pinQueues = pinQueuesRef.current;
    return () => {
      mountedRef.current = false;
      queueRef.current = [];
      scheduled.clear();
      reservedEntries.clear();
      pinBusy.clear();
      pinQueues.clear();
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      active.forEach(({ controller }) => controller.abort());
      active.clear();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!active) {
        cancelLoads(new Set(scheduledRef.current.keys()));
        return;
      }
      expandedRef.current.forEach((key) => {
        const state = nodesRef.current.get(key);
        if (state?.loaded || state?.loading) return;
        const { root, path } = splitNodeKey(key);
        scheduleLoad(root, path);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, cancelLoads, scheduleLoad]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportHeight(viewport.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const rowData = useMemo<ExplorerRowData>(() => ({
    rows,
    selectedId,
    hoveredId,
    setHoveredId,
    isMobile,
    copiedPath,
    pinnedIds,
    pinBusyIds,
    onActivate: activateNode,
    onRetry: (root, path, append) => scheduleLoad(root, path, append),
    onCancel: handleCancelLoad,
    onLoadMore: (root, path) => scheduleLoad(root, path, true),
    onCopy: handleCopy,
    onPin: handlePin,
    onAddToCollection,
  }), [
    activateNode,
    copiedPath,
    handleCancelLoad,
    handleCopy,
    handlePin,
    hoveredId,
    isMobile,
    onAddToCollection,
    pinnedIds,
    pinBusyIds,
    rows,
    scheduleLoad,
    selectedId,
  ]);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={styles.titleBlock}>
          <span style={styles.title}>Explorer</span>
        </div>
        <span style={styles.sortLabel}>sort by:</span>
        <select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as ExplorerSortKey)}
          style={styles.sortSelect}
          aria-label="Sort Explorer by"
          title="Sort Explorer by"
        >
          <option value="name">Name</option>
          <option value="modified">Modified</option>
        </select>
        <button
          type="button"
          onClick={() => setSortAsc((current) => !current)}
          style={styles.toolbarButton}
          title={sortAsc ? 'Sort descending' : 'Sort ascending'}
          aria-label={sortAsc ? 'Sort descending' : 'Sort ascending'}
        >
          <SortDirectionIcon ascending={sortAsc} />
        </button>
        <button
          type="button"
          onClick={refreshCurrentBranch}
          style={styles.toolbarButton}
          title="Refresh selected folder and its parent"
          disabled={enabledRoots.length === 0}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          onClick={collapseAll}
          style={styles.toolbarButton}
          title="Collapse all folders"
          disabled={expanded.size === 0}
        >
          <CollapseIcon />
        </button>
      </div>
      {notice && (
        <div style={styles.notice} role="status">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => showNotice(null)}
            style={styles.noticeDismiss}
            aria-label="Dismiss Explorer message"
          >
            ×
          </button>
        </div>
      )}
      <div
        ref={viewportRef}
        style={styles.viewport}
        role="tree"
        tabIndex={0}
        aria-label="File Explorer"
        aria-activedescendant={selectedNode ? `explorer-row-${selectedNode.index}` : undefined}
        onFocus={() => {
          if (!selectedId && nodeRows[0]) selectNodeAt(nodeRows[0].index);
        }}
        onKeyDown={handleTreeKeyDown}
      >
        {enabledRoots.length === 0 ? (
          <div style={styles.empty}>
            <span>No roots configured.</span>
            <span style={styles.emptyHint}>Add a root in Settings.</span>
          </div>
        ) : viewportHeight > 0 ? (
          <FixedSizeList
            ref={listRef}
            height={viewportHeight}
            itemCount={rows.length}
            itemSize={rowHeight}
            itemData={rowData}
            itemKey={(index, data) => data.rows[index].id}
            width="100%"
            overscanCount={8}
          >
            {ExplorerVirtualRow}
          </FixedSizeList>
        ) : null}
      </div>
    </div>
  );
}

interface ExplorerRowData {
  rows: ExplorerRow[];
  selectedId: string | null;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
  isMobile: boolean;
  copiedPath: string | null;
  pinnedIds: Set<string>;
  pinBusyIds: Set<string>;
  onActivate: (row: Extract<ExplorerRow, { kind: 'node' }>) => void;
  onRetry: (root: string, path: string, append: boolean) => void;
  onCancel: (root: string, path: string) => void;
  onLoadMore: (root: string, path: string) => void;
  onCopy: (path: string, label: string) => void;
  onPin: (row: Extract<ExplorerRow, { kind: 'node' }>) => void;
  onAddToCollection?: (root: string, path: string, anchor: HTMLElement) => void;
}

function ExplorerVirtualRow({
  index,
  style,
  data,
}: ListChildComponentProps<ExplorerRowData>) {
  const row = data.rows[index];
  if (row.kind === 'loading') {
    return (
      <div
        style={{
          ...style,
          ...styles.messageRow,
          paddingLeft: 12 + row.depth * 14,
        }}
        role="status"
      >
        <span style={styles.inlineSpinner} />
        <span style={styles.loadingText}>{row.message}</span>
        <button
          type="button"
          onClick={() => data.onCancel(row.root, row.parentPath)}
          style={styles.inlineButton}
        >
          Cancel
        </button>
      </div>
    );
  }
  if (row.kind === 'message') {
    return (
      <div
        style={{
          ...style,
          ...styles.messageRow,
          paddingLeft: 12 + row.depth * 14,
        }}
        role="alert"
      >
        <span style={styles.errorText} title={row.message}>{row.message}</span>
        {row.retryable && (
          <button
            type="button"
            onClick={() => data.onRetry(row.root, row.parentPath, row.append)}
            style={styles.inlineButton}
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  if (row.kind === 'load-more') {
    return (
      <div
        style={{
          ...style,
          ...styles.messageRow,
          paddingLeft: 12 + row.depth * 14,
        }}
      >
        {row.loading ? (
          <>
            <span style={styles.inlineSpinner} />
            <span style={styles.loadingText}>Loading more…</span>
            <button
              type="button"
              onClick={() => data.onCancel(row.root, row.parentPath)}
              style={styles.inlineButton}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => data.onLoadMore(row.root, row.parentPath)}
            style={styles.loadMoreButton}
          >
            Load {PAGE_LIMIT} more…
          </button>
        )}
      </div>
    );
  }

  const selected = data.selectedId === row.id;
  const hovered = data.hoveredId === row.id;
  const showActions = !row.denied && (data.isMobile || selected || hovered);
  const canPin = row.isDirectory && !row.denied;
  const pinned = data.pinnedIds.has(row.id);
  const pinBusy = data.pinBusyIds.has(row.id);
  const canCollect = !!(
    data.onAddToCollection
    && row.entry?.entry_type === 'file'
    && !row.denied
  );

  return (
    <div
      id={`explorer-row-${index}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.isDirectory ? row.expanded : undefined}
      style={{
        ...style,
        ...styles.nodeRow,
        paddingLeft: 6 + row.depth * 14,
        ...(selected ? styles.nodeSelected : hovered ? styles.nodeHovered : {}),
        ...(row.denied ? styles.nodeDenied : {}),
      }}
      onClick={() => data.onActivate(row)}
      onMouseEnter={() => data.setHoveredId(row.id)}
      onMouseLeave={() => data.setHoveredId(null)}
      title={row.fullPath}
    >
      {row.isDirectory ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (!row.denied) data.onActivate(row);
          }}
          style={styles.chevronButton}
          aria-label={row.expanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
          disabled={row.denied}
        >
          {row.loading ? <span style={styles.spinner} /> : <Chevron open={row.expanded} />}
        </button>
      ) : (
        <span style={styles.chevronSpacer} />
      )}
      <span style={styles.entryIcon}>
        {row.isRoot ? <IconFolder /> : row.entry ? getEntryIcon(row.entry) : <IconFolder />}
      </span>
      <span style={{ ...styles.nodeLabel, ...(row.isRoot ? styles.rootLabel : {}) }}>
        {row.label}
      </span>
      {row.denied && <span style={styles.deniedBadge}>denied</span>}
      {showActions && (
        <span style={styles.actions}>
          {canPin && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void data.onPin(row);
              }}
              style={{
                ...styles.actionButton,
                ...(pinned ? styles.actionButtonActive : {}),
                ...(pinBusy ? styles.actionButtonDisabled : {}),
              }}
              title={pinBusy
                ? `${pinned ? 'Unpinning' : 'Pinning'}…`
                : pinned
                  ? 'Unpin folder'
                  : 'Pin folder to sidebar'}
              aria-label={`${pinned ? 'Unpin' : 'Pin'} ${row.label}`}
              aria-pressed={pinned}
              disabled={pinBusy}
            >
              {pinBusy ? <span style={styles.inlineSpinner} /> : <IconPin />}
            </button>
          )}
          {canCollect && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                data.onAddToCollection?.(row.root, row.path, event.currentTarget);
              }}
              style={styles.actionButton}
              title="Add to collection"
              aria-label={`Add ${row.label} to collection`}
            >
              <AddIcon />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void data.onCopy(row.fullPath, row.id);
            }}
            style={styles.actionButton}
            title={data.copiedPath === row.id ? 'Copied!' : 'Copy full path'}
            aria-label={`Copy full path for ${row.label}`}
          >
            {data.copiedPath === row.id ? <CheckIcon /> : <CopyIcon />}
          </button>
        </span>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      style={{
        display: 'block',
        width: 12,
        height: 12,
        transform: open ? 'rotate(90deg)' : 'none',
      }}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg style={styles.svg} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M12 8a4 4 0 1 1-1.2-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M12 3.5v3H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SortDirectionIcon({ ascending }: { ascending: boolean }) {
  return (
    <svg style={styles.svg} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={ascending ? 'M8 13V3M4.5 6.5 8 3l3.5 3.5' : 'M8 3v10m-3.5-3.5L8 13l3.5-3.5'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg style={styles.svg} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 5h10M5 8h6M7 11h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg style={styles.svgSmall} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg style={styles.svgSmall} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg style={styles.svgSmall} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    background: c.bg,
    color: c.text,
    fontFamily: font.sans,
  },
  toolbar: {
    height: 45,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px 0 12px',
    borderBottom: `1px solid ${c.border}`,
    boxSizing: 'border-box',
  },
  titleBlock: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
  },
  sortSelect: {
    width: 86,
    height: 28,
    flexShrink: 0,
    padding: '0 22px 0 7px',
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    background: c.bg,
    color: c.textSecondary,
    fontFamily: font.sans,
    fontSize: 11.5,
    cursor: 'pointer',
  },
  sortLabel: {
    flexShrink: 0,
    color: c.textMuted,
    fontSize: 11.5,
    whiteSpace: 'nowrap',
  },
  toolbarButton: {
    width: 30,
    height: 28,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    background: c.bg,
    color: c.textSecondary,
    cursor: 'pointer',
  },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px 6px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.warningBg,
    color: c.textSecondary,
    fontSize: 11.5,
    lineHeight: 1.35,
  },
  noticeDismiss: {
    marginLeft: 'auto',
    width: 24,
    height: 24,
    border: 'none',
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    fontSize: 16,
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    outline: 'none',
  },
  empty: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    color: c.textMuted,
    fontSize: 13,
  },
  emptyHint: {
    color: c.textFaint,
    fontSize: 12,
  },
  nodeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    paddingRight: 6,
    boxSizing: 'border-box',
    cursor: 'pointer',
    userSelect: 'none',
  },
  nodeHovered: {
    background: c.bgMuted,
  },
  nodeSelected: {
    background: c.accentBg,
  },
  nodeDenied: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  chevronButton: {
    width: 20,
    height: 24,
    flexShrink: 0,
    padding: 0,
    border: 'none',
    borderRadius: radius.sm,
    background: 'transparent',
    color: c.textMuted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  chevronSpacer: {
    width: 20,
    flexShrink: 0,
  },
  entryIcon: {
    width: 18,
    height: 18,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12.5,
    color: c.text,
  },
  rootLabel: {
    fontWeight: 600,
  },
  deniedBadge: {
    flexShrink: 0,
    fontSize: 9.5,
    color: c.warning,
  },
  actions: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 1,
    flexShrink: 0,
    paddingLeft: 4,
    background: 'inherit',
  },
  actionButton: {
    width: 26,
    height: 26,
    padding: 0,
    border: 'none',
    borderRadius: radius.sm,
    background: c.bg,
    color: c.textMuted,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonActive: {
    background: c.accentBg,
    color: c.accent,
  },
  actionButtonDisabled: {
    opacity: 0.55,
    cursor: 'wait',
  },
  messageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
    boxSizing: 'border-box',
    fontSize: 11,
  },
  errorText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: c.danger,
  },
  loadingText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: c.textMuted,
  },
  inlineButton: {
    flexShrink: 0,
    border: 'none',
    background: 'transparent',
    color: c.accent,
    cursor: 'pointer',
    fontSize: 11,
  },
  loadMoreButton: {
    border: 'none',
    background: 'transparent',
    color: c.accent,
    cursor: 'pointer',
    fontSize: 11.5,
    padding: '3px 4px',
  },
  spinner: {
    width: 9,
    height: 9,
    border: `1.5px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
    boxSizing: 'border-box',
  },
  inlineSpinner: {
    width: 10,
    height: 10,
    flexShrink: 0,
    border: `1.5px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
    boxSizing: 'border-box',
  },
  svg: {
    display: 'block',
    width: 16,
    height: 16,
  },
  svgSmall: {
    display: 'block',
    width: 14,
    height: 14,
  },
};
