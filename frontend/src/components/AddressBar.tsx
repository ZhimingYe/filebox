import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as api from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  selectedRoot: string | null;
  currentPath: string;
  roots: { name: string; path_display: string; enabled: boolean }[];
  entries: api.FsEntry[];
  agentId: string;
  onNavigate: (root: string, path: string) => void;
}

export function AddressBar({ selectedRoot, currentPath, roots, entries, agentId, onNavigate }: Props) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState('');
  const [suggestions, setSuggestions] = useState<api.FsEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const cache = useRef<Map<string, api.FsEntry[]>>(new Map());

  const rootObj = useMemo(
    () => roots.find((r) => r.name === selectedRoot) || null,
    [roots, selectedRoot],
  );

  // Enter edit mode: pre-fill with current path
  const startEditing = useCallback(() => {
    setTyped(currentPath);
    setEditing(true);
    setSuggestions([]);
    setSelectedIdx(0);
  }, [currentPath]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const len = inputRef.current.value.length;
      inputRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  // Click outside → close
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing]);

  // Stable entries reference — only changes when actual entry names change
  const entriesByName = useMemo(() => entries, [entries.map((e) => e.name).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse typed path into parent dir + partial segment
  const { parent, partial } = useMemo(() => {
    const t = typed.startsWith('/') ? typed : '/' + typed;
    const idx = t.lastIndexOf('/');
    if (idx <= 0) return { parent: '/', partial: t.slice(1) };
    return { parent: t.slice(0, idx) || '/', partial: t.slice(idx + 1) };
  }, [typed]);

  // Update suggestions as user types
  useEffect(() => {
    if (!editing || !selectedRoot) return;

    let cancelled = false;

    const fetchAndFilter = async () => {
      let dirs: api.FsEntry[] = [];

      if (parent === currentPath) {
        // Use already-loaded entries from the current directory
        dirs = entriesByName.filter((e) => e.entry_type === 'directory' && !e.denied);
      } else {
        // Check cache first
        const cacheKey = `${selectedRoot}:${parent}`;
        if (cache.current.has(cacheKey)) {
          dirs = cache.current.get(cacheKey)!;
        } else {
          try {
            const data = await api.fsList(agentId, selectedRoot, parent, 200);
            if (cancelled || data.error) return;
            dirs = data.items.filter((e) => e.entry_type === 'directory' && !e.denied);
            cache.current.set(cacheKey, dirs);
          } catch {
            return;
          }
        }
      }

      if (cancelled) return;

      if (!partial) {
        setSuggestions(dirs);
      } else {
        const lower = partial.toLowerCase();
        setSuggestions(dirs.filter((d) => d.name.toLowerCase().startsWith(lower)));
      }
      setSelectedIdx(0);
    };

    fetchAndFilter();
    return () => { cancelled = true; };
  }, [editing, parent, partial, selectedRoot, currentPath, entriesByName, agentId]);

  // Clear cache when agent or roots change
  useEffect(() => {
    cache.current.clear();
  }, [agentId, roots]);

  const normalizePath = (p: string): string => {
    if (!p || p === '/') return '/';
    let s = p.replace(/\/+/g, '/');
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  };

  const handleNavigate = (path: string) => {
    if (!selectedRoot) return;
    onNavigate(selectedRoot, normalizePath(path));
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditing(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (suggestions.length > 0) {
        const s = suggestions[selectedIdx];
        const t = typed.startsWith('/') ? typed : '/' + typed;
        const idx = t.lastIndexOf('/');
        const prefix = idx <= 0 ? '/' : t.slice(0, idx) + '/';
        const next = prefix + s.name + '/';
        setTyped(next);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0 && selectedIdx < suggestions.length) {
        // Navigate into the selected suggestion
        const t = typed.startsWith('/') ? typed : '/' + typed;
        const idx = t.lastIndexOf('/');
        const prefix = idx <= 0 ? '/' : t.slice(0, idx) + '/';
        handleNavigate(prefix + suggestions[selectedIdx].name);
      } else {
        handleNavigate(typed);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!rootObj) return;
    const pasted = e.clipboardData.getData('text').trim();
    if (pasted.startsWith(rootObj.path_display)) {
      e.preventDefault();
      const relative = pasted.slice(rootObj.path_display.length) || '/';
      setTyped(relative.startsWith('/') ? relative : '/' + relative);
    }
  };

  const handleSuggestionClick = (entry: api.FsEntry) => {
    const t = typed.startsWith('/') ? typed : '/' + typed;
    const idx = t.lastIndexOf('/');
    const prefix = idx <= 0 ? '/' : t.slice(0, idx) + '/';
    handleNavigate(prefix + entry.name);
  };

  if (!selectedRoot || !rootObj) {
    return <div style={styles.bar} />;
  }

  if (!editing) {
    // Display mode: root chip + clickable path segments + edit button
    const segments = currentPath.split('/').filter(Boolean);
    return (
      <div style={styles.bar}>
        <span style={styles.rootChip} onClick={() => onNavigate(selectedRoot!, '/')} title="Go to root">{selectedRoot}</span>
        <div style={styles.scrollArea}>
          <span
            style={styles.crumb}
            onClick={() => onNavigate(selectedRoot!, '/')}
            title="Go to root"
          >
            /
          </span>
          {segments.map((s, i) => (
            <span key={i}>
              <span
                style={styles.crumb}
                onClick={() => onNavigate(selectedRoot!, '/' + segments.slice(0, i + 1).join('/'))}
              >
                {s}
              </span>
              {i < segments.length - 1 && <span style={styles.crumbSep}>/</span>}
            </span>
          ))}
        </div>
        <span
          role="button"
          tabIndex={0}
          onClick={startEditing}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') startEditing(); }}
          style={styles.editBtn}
          title="Edit path"
        >
          <svg style={{ display: 'block', width: 14, height: 14 }} viewBox="0 0 16 16" fill="none">
            <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.5 3.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </span>
      </div>
    );
  }

  // Edit mode
  return (
    <div ref={barRef} style={styles.bar}>
      <span style={styles.rootChip}>{selectedRoot}</span>
      <div style={styles.inputWrap}>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="/path/to/directory"
          style={styles.input}
          spellCheck={false}
          autoComplete="off"
        />
        {editing && suggestions.length > 0 && (
          <div style={styles.dropdown}>
            {suggestions.map((s, i) => (
              <div
                key={s.name}
                style={{
                  ...styles.suggestion,
                  ...(i === selectedIdx ? styles.suggestionSelected : {}),
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSuggestionClick(s);
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <span style={styles.suggestionIcon}>
                  <svg style={{ display: 'block', width: 14, height: 14 }} viewBox="0 0 16 16" fill="none">
                    <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="#94a3b8"/>
                    <path d="M2 6h12v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V6Z" fill="#cbd5e1"/>
                  </svg>
                </span>
                {s.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    padding: '4px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle,
    fontSize: 12,
    minHeight: 32,
    position: 'relative',
  },
  rootChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: radius.sm,
    background: c.accentBg,
    color: c.accent,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: font.sans,
    flexShrink: 0,
    marginRight: 4,
    letterSpacing: 0.2,
    cursor: 'pointer',
  },
  scrollArea: {
    flex: 1,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    whiteSpace: 'nowrap',
    display: 'flex',
    alignItems: 'center',
    gap: 0,
  },
  crumb: {
    cursor: 'pointer',
    color: c.accent,
    fontFamily: font.mono,
    fontSize: 12,
  },
  crumbSep: {
    color: c.textMuted,
    fontFamily: font.mono,
    fontSize: 13,
    fontWeight: 500,
    margin: '0 1px',
  },
  editBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    border: 'none',
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: 8,
    boxSizing: 'border-box',
    padding: 0,
  },
  inputWrap: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
  },
  input: {
    width: '100%',
    padding: '2px 0',
    border: 'none',
    background: 'transparent',
    color: c.text,
    fontSize: 12,
    fontFamily: font.mono,
    outline: 'none',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    maxHeight: 220,
    overflowY: 'auto',
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    zIndex: 100,
    marginTop: 2,
  },
  suggestion: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    color: c.text,
    fontFamily: font.mono,
    transition: 'background 0.08s',
  },
  suggestionSelected: {
    background: c.accentBg,
  },
  suggestionIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
};
