import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api/client';
import { c, radius, font } from '../theme';
import { IconPin, IconClose, IconChevronRight } from './icons';

interface Props {
  agent: api.AgentInfo;
  collapsed: boolean;
  /** Navigate the file browser to this root + relative path. */
  onNavigate: (root: string, path: string) => void;
  /** Remove a single pinned path from a root's pinned_folders set. The agent
   *  id is already known to the parent (it's this section's `agent`), so the
   *  callback is bound to (root, path). Returns true on success so this
   *  section can show a failure banner. */
  onUnpin: (root: string, path: string) => Promise<boolean>;
}

interface PinRef {
  root: string;
  path: string;
}

/// Cache key MUST include the agent id: two agents can have a root named
/// "data" with a "/reports" pin, and without the agent discriminator the
/// "exists" result from one would leak into the other's view. Including the
/// agent id also means switching agents naturally invalidates the cache.
const cacheKey = (agentId: string, p: PinRef) => `${agentId}|${p.root}|${p.path}`;

/// Sidebar "Pinned Folders" section. Pins are stored per-root in
/// agent_state.json (backend-authoritative) and surface here for quick
/// navigation. Only enabled roots are navigable, so pins on a disabled root
/// are hidden until the root is re-enabled — but they are NEVER lost: the
/// pin data lives on the agent, not in this component.
///
/// Grouping: pins are shown grouped under their owning root (a collapsible
/// header per root), because a flat list made it impossible to tell which root
/// a pin belonged to — especially with several roots each pinning folders. The
/// group header carries the root name; each pin row shows only its relative
/// path, so ownership is unambiguous and rows stay short.
///
/// Collapsed sidebar: there is no room for group headers, so instead of a flat
/// wall of identical pin icons (which gave no ownership/path cue and were
/// unusable when many pins existed), we render a single "Pinned" entry with a
/// count badge. Clicking it opens a popover that lists all pins grouped by
/// root — the same layout as the expanded section — so the user can navigate
/// or unpin from there without expanding the whole sidebar.
///
/// Stability notes (the PM's hard requirement):
/// - A pinned folder whose target no longer exists (deleted, moved, or behind
///   a transiently-unmounted NFS/SSHFS mount) is still shown, rendered muted
///   with a "Folder not found" tooltip. We never auto-delete a pin from
///   storage on a missing check — that check is best-effort and cosmetic.
///   The user removes stale pins explicitly via the unpin button.
/// - The existence probe (fsStat) is skipped when the agent is offline,
///   bounded in concurrency, abortable on unmount/agent-switch, and cached so
///   unchanged pins aren't re-probed every render.
/// - Empty pin list: the whole section is hidden by the parent, so this
///   component always has ≥1 pin when rendered.
export function PinnedFolders({ agent, collapsed, onNavigate, onUnpin }: Props) {
  // Pins grouped by owning root, preserving the agent's root order. A root
  // with no pins is skipped entirely (no empty groups).
  const groups = useMemo(() => {
    const out: { root: string; pins: PinRef[] }[] = [];
    for (const r of agent.roots) {
      if (!r.enabled) continue;
      if (r.pinned_folders.length === 0) continue;
      out.push({
        root: r.name,
        pins: r.pinned_folders.map((p) => ({ root: r.name, path: p })),
      });
    }
    return out;
  }, [agent.roots]);

  // Flatten for the existence probe (works over all pins regardless of group).
  const pins = useMemo<PinRef[]>(() => groups.flatMap((g) => g.pins), [groups]);

  // Best-effort "is this folder still there?" probe. We only run it when the
  // agent is online, and store the set of *missing* pin keys. fsStat errors
  // (denied, offline, network) are treated as "unknown" rather than "missing"
  // so we never grey out a pin that's merely behind a permission boundary.
  //
  // Concurrency is bounded to PROBE_CONCURRENCY so a fleet of pins (or a slow
  // NFS/SSHFS mount) can't fan out an unbounded batch of hub/agent requests.
  // The fetch is abortable: unmount or agent/online-status change cancels any
  // in-flight probes so they don't write stale state or pile up requests.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Cache "still exists" results so unchanged pins aren't re-probed each time
  // the agent list refreshes (e.g. on every SSE heartbeat). Negatives are NOT
  // cached (a folder may reappear). Positives ARE cached, but with a TTL:
  // without one, a folder that's later deleted would forever read as "exists",
  // and the greyed-out cue that signals a stale pin would never fire. We store
  // the timestamp alongside the boolean and treat an entry older than
  // POSITIVE_TTL_MS as stale (re-probe).
  const existsCache = useRef<Map<string, { exists: boolean; at: number }>>(new Map());
  const probeSeq = useRef(0);

  useEffect(() => {
    // No point probing when offline; clear any stale "missing" flags so a pin
    // doesn't stay greyed after the agent disconnects.
    if (agent.status !== 'online') {
      setMissing(new Set());
      return;
    }
    if (pins.length === 0) return;

    const controller = new AbortController();
    const seq = ++probeSeq.current;
    const now = Date.now();

    (async () => {
      const gone = new Set<string>();
      // Run probes in bounded batches to cap concurrent hub/agent requests.
      for (let i = 0; i < pins.length; i += PROBE_CONCURRENCY) {
        if (controller.signal.aborted) return;
        const batch = pins.slice(i, i + PROBE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((p) => {
            const k = cacheKey(agent.id, p);
            // Fast-path: a fresh positive cache hit skips the network probe.
            const cached = existsCache.current.get(k);
            if (cached && cached.exists && now - cached.at < POSITIVE_TTL_MS) {
              return Promise.resolve('exists' as const);
            }
            return api.fsStat(agent.id, p.root, p.path, controller.signal);
          }),
        );
        results.forEach((res, j) => {
          if (res.status !== 'fulfilled') return; // abort/network/timeout → unknown
          const v = res.value;
          if (v === 'exists') return; // from the cache fast-path
          const stat = (v as { stat?: api.FsEntry | null })?.stat;
          // Missing (stat null) OR exists but isn't a directory (got deleted and
          // replaced by a file) both count as "not a usable folder".
          if (!stat || stat.entry_type !== 'directory') {
            // A denied entry still exists, just unreadable — don't grey it.
            if (!stat?.denied) gone.add(cacheKey(agent.id, batch[j]));
          } else {
            existsCache.current.set(cacheKey(agent.id, batch[j]), {
              exists: true,
              at: Date.now(),
            });
          }
        });
      }
      if (controller.signal.aborted || seq !== probeSeq.current) return;
      setMissing(gone);
    })();

    return () => {
      controller.abort();
    };
  }, [agent.id, agent.status, pins]);

  // Per-root collapse state. Default expanded; the choice persists across
  // re-renders (agent refresh, SSE) and is keyed by root name. We don't reset
  // it when the agent changes — the keys are root names, and a root that
  // disappears just stops rendering its group.
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const toggleRoot = (root: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  // Relative-path label for a pin WITHIN its group: the root itself is "/"
  // (rendered as "root" → just the word "root" feels odd, so show the folder
  // glyph + the root name); a subdir shows just the path. The owning root is
  // already the group header, so we do NOT repeat it here.
  const relLabel = (p: PinRef) =>
    p.path === '/' ? '(root)' : p.path.replace(/^\//, '');

  // Section-level transient error: a failed unpin. Violating "never freeze
  // silently" — a clicked × that silently no-ops on a flaky connection is a
  // bug. Auto-clears after a few seconds.
  const [unpinError, setUnpinError] = useState<string | null>(null);
  const unpinErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (unpinErrorTimer.current) clearTimeout(unpinErrorTimer.current);
    };
  }, []);
  const showUnpinError = (msg: string) => {
    setUnpinError(msg);
    if (unpinErrorTimer.current) clearTimeout(unpinErrorTimer.current);
    unpinErrorTimer.current = setTimeout(() => setUnpinError(null), 4000);
  };

  const doUnpin = async (p: PinRef) => {
    const ok = await onUnpin(p.root, p.path);
    if (!ok) showUnpinError(`Couldn't unpin ${p.root} › ${relLabel(p)} — try again`);
  };

  if (collapsed) {
    // Collapsed rail: a single "Pinned" entry with a count badge. Clicking it
    // opens a popover that mirrors the expanded grouped layout, so the user
    // can navigate/unpin without expanding the whole sidebar. This replaces a
    // flat wall of identical pin icons that gave no ownership or path cue.
    return (
      <CollapsedPinnedEntry
        agent={agent}
        groups={groups}
        missing={missing}
        onNavigate={onNavigate}
        onUnpin={doUnpin}
        unpinError={unpinError}
        collapsedRoots={collapsedRoots}
        toggleRoot={toggleRoot}
        relLabel={relLabel}
      />
    );
  }

  return (
    <div style={styles.list}>
      {groups.map((g) => {
        const isCollapsed = collapsedRoots.has(g.root);
        return (
          <div key={g.root} style={styles.group}>
            <button
              onClick={() => toggleRoot(g.root)}
              title={isCollapsed ? `Expand ${g.root}` : `Collapse ${g.root}`}
              style={styles.groupHeader}
            >
              {/* Chevron rotates 90° when expanded (▶ → ▼). */}
              <IconChevronRight
                style={{
                  flexShrink: 0,
                  transition: 'transform 0.15s',
                  transform: isCollapsed ? 'none' : 'rotate(90deg)',
                  color: c.textMuted,
                }}
              />
              <span style={styles.groupLabel}>{g.root}</span>
              <span style={styles.groupCount}>{g.pins.length}</span>
            </button>
            {!isCollapsed &&
              g.pins.map((p) => (
                <PinRow
                  key={cacheKey(agent.id, p)}
                  pin={p}
                  missing={missing.has(cacheKey(agent.id, p))}
                  label={relLabel(p)}
                  onNavigate={onNavigate}
                  onUnpin={doUnpin}
                />
              ))}
          </div>
        );
      })}
      {unpinError && <div style={styles.errorBanner}>{unpinError}</div>}
    </div>
  );
}

/// The collapsed-rail entry: one button with a pin glyph + count badge, that
/// toggles a popover listing all pins grouped by root (same layout as the
/// expanded section). A popover — rather than a flat icon list — keeps the
/// narrow rail readable when there are many pins across several roots.
function CollapsedPinnedEntry({
  agent,
  groups,
  missing,
  onNavigate,
  onUnpin,
  unpinError,
  collapsedRoots,
  toggleRoot,
  relLabel,
}: {
  agent: api.AgentInfo;
  groups: { root: string; pins: PinRef[] }[];
  missing: Set<string>;
  onNavigate: (root: string, path: string) => void;
  onUnpin: (p: PinRef) => void;
  unpinError: string | null;
  collapsedRoots: Set<string>;
  toggleRoot: (root: string) => void;
  relLabel: (p: PinRef) => string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The popover is rendered with position:fixed (see below), so it is NOT a
  // DOM child of `wrapRef` for hit-testing purposes; we track it separately so
  // the outside-click handler can tell a click-inside-popover from a real
  // outside click.
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchor coords for the fixed-position popover. Recomputed each time it opens
  // AND on viewport changes while open, so scrolling/resizing the sidebar keeps
  // the popover glued to its trigger button instead of drifting off.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.top, left: r.right + 8 });
  };
  useEffect(() => {
    if (!open) return;
    place();
    // Re-anchor on any scroll (the sidebar middle region scrolls) and on
    // viewport resize. `capture: true` so nested scroll containers also fire.
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Close on outside click: the trigger button, the popover itself, and the
      // unpin buttons inside it are all "inside". Anything else closes.
      const t = e.target as Node;
      if (
        (wrapRef.current && wrapRef.current.contains(t)) ||
        (popoverRef.current && popoverRef.current.contains(t))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const totalPins = groups.reduce((n, g) => n + g.pins.length, 0);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={`Pinned folders (${totalPins})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={styles.collapsedEntry}
      >
        <IconPin />
      </button>
      <span style={styles.collapsedBadge}>{totalPins}</span>
      {open && anchor && (
        <div
          ref={popoverRef}
          style={{ ...styles.popover, top: anchor.top, left: anchor.left }}
          role="dialog"
          aria-label="Pinned folders"
        >
          <div style={styles.popoverHeader}>Pinned</div>
          <div style={styles.popoverBody}>
            {groups.map((g) => {
              const isCollapsed = collapsedRoots.has(g.root);
              return (
                <div key={g.root} style={styles.group}>
                  <button
                    onClick={() => toggleRoot(g.root)}
                    title={isCollapsed ? `Expand ${g.root}` : `Collapse ${g.root}`}
                    style={styles.groupHeader}
                  >
                    <IconChevronRight
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.15s',
                        transform: isCollapsed ? 'none' : 'rotate(90deg)',
                        color: c.textMuted,
                      }}
                    />
                    <span style={styles.groupLabel}>{g.root}</span>
                    <span style={styles.groupCount}>{g.pins.length}</span>
                  </button>
                  {!isCollapsed &&
                    g.pins.map((p) => (
                      <PinRow
                        key={cacheKey(agent.id, p)}
                        pin={p}
                        missing={missing.has(cacheKey(agent.id, p))}
                        label={relLabel(p)}
                        onNavigate={(r, path) => {
                          onNavigate(r, path);
                          setOpen(false);
                        }}
                        onUnpin={onUnpin}
                      />
                    ))}
                </div>
              );
            })}
          </div>
          {unpinError && <div style={styles.errorBanner}>{unpinError}</div>}
        </div>
      )}
    </div>
  );
}

/// A single pinned-folder row, indented under its root's group header. Hover
/// state is local (inline style on a token), NOT global CSS. The unpin button
/// is always visible at reduced opacity and brightens on row hover/focus so
/// keyboard and touch users can discover it.
function PinRow({
  pin,
  missing,
  label,
  onNavigate,
  onUnpin,
}: {
  pin: PinRef;
  missing: boolean;
  label: string;
  onNavigate: (root: string, path: string) => void;
  onUnpin: (p: PinRef) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...styles.row,
        background: hovered ? c.bgMuted : 'transparent',
        paddingLeft: GROUP_INDENT,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => onNavigate(pin.root, pin.path)}
        title={missing ? 'Folder not found — click to try anyway' : `${pin.root} › ${label}`}
        style={{
          ...styles.rowMain,
          color: missing ? c.textFaint : hovered ? c.text : c.textSecondary,
        }}
      >
        <IconPin style={{ flexShrink: 0 }} />
        <span style={styles.rowLabel}>{label}</span>
      </button>
      <button
        onClick={() => onUnpin(pin)}
        title="Unpin"
        aria-label={`Unpin ${pin.root} ${label}`}
        style={{
          ...styles.unpinBtn,
          color: hovered ? c.textMuted : c.textFaint,
        }}
      >
        <IconClose />
      </button>
    </div>
  );
}

const PROBE_CONCURRENCY = 4;
// A positive "exists" cache entry is trusted for this long, then re-probed.
// Long enough to skip redundant probes across SSE-driven refreshes (~seconds
// apart), short enough that a since-deleted folder is re-detected within a
// minute rather than forever read as present.
const POSITIVE_TTL_MS = 60_000;
// Indent pin rows under their group header so the hierarchy reads clearly.
const GROUP_INDENT = 16;

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  group: { display: 'flex', flexDirection: 'column' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 8px', border: 'none', background: 'transparent',
    cursor: 'pointer', width: '100%', textAlign: 'left',
    borderRadius: radius.sm, transition: 'background 0.15s',
    fontFamily: font.sans,
  },
  groupLabel: {
    flex: 1, fontSize: 12, fontWeight: 600, color: c.textSecondary,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  groupCount: {
    fontSize: 10.5, fontWeight: 500, color: c.textMuted,
    background: c.bgMuted, borderRadius: radius.pill,
    padding: '1px 6px', minWidth: 16, textAlign: 'center',
  },
  row: {
    display: 'flex', alignItems: 'center', borderRadius: radius.md,
    transition: 'background 0.15s',
  },
  rowMain: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 8px', border: 'none', background: 'transparent',
    cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: font.sans,
    transition: 'color 0.15s',
  },
  rowLabel: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  unpinBtn: {
    flexShrink: 0, width: 22, height: 22, lineHeight: 1,
    border: 'none', background: 'transparent', cursor: 'pointer',
    borderRadius: radius.sm, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginRight: 4, transition: 'color 0.15s',
  },
  errorBanner: {
    fontSize: 11.5, color: c.danger, padding: '4px 8px',
    fontFamily: font.sans,
  },
  // Collapsed rail: single entry + popover
  collapsedEntry: {
    width: 40, height: 36, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    padding: 0, borderRadius: radius.md, border: 'none', cursor: 'pointer',
    background: 'transparent', color: c.textSecondary, transition: 'all 0.15s',
  },
  collapsedBadge: {
    position: 'absolute',
    top: 2, right: 2,
    minWidth: 15, height: 15, padding: '0 4px',
    fontSize: 9.5, fontWeight: 600, lineHeight: '15px',
    textAlign: 'center', color: '#fff', background: c.accent,
    borderRadius: radius.pill, pointerEvents: 'none',
    fontFamily: font.sans,
  },
  popover: {
    // position:fixed (not absolute) so the popover escapes the sidebar's
    // overflow-clipping containers — specifically the new `sidebarScroll`
    // region (overflow-x:hidden) which used to chop the old absolute popover
    // off entirely. The actual top/left are set inline from the trigger
    // button's getBoundingClientRect() each time it opens and on every
    // scroll/resize while open.
    position: 'fixed',
    width: 240, maxHeight: 360,
    background: c.surface, border: `1px solid ${c.border}`,
    borderRadius: radius.md, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    zIndex: 1000, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  popoverHeader: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.8, fontWeight: 600, padding: '8px 12px',
    borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
    fontFamily: font.sans,
  },
  popoverBody: {
    flex: 1, overflowY: 'auto', padding: '6px 4px',
    display: 'flex', flexDirection: 'column', gap: 2,
  },
};
