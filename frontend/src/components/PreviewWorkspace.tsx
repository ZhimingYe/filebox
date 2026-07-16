import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PreviewPane } from './PreviewPane';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import { fileRawUrl } from '../api/client';
import { c, radius, font, shadow, menuList, menuListItemStyle, menuListSubStyle } from '../theme';
import type { PreviewTab } from '../hooks/usePreviewTabs';

// ── Desktop preview panel ─────────────────────────────────────────────────
//
// Renders the desktop preview area: an optional tab strip (shown once more
// than one tab is open), the active tab's header (path + download + close),
// and exactly ONE PreviewPane for the active tab. Inactive tabs are pure
// metadata held by the parent's usePreviewTabs hook — they never mount a
// preview body, so PDF/Image/HTML/Monaco resources are only
// alive for the visible tab.
//
// Switching tabs remounts PreviewPane internals via the `key` prop (the
// stable tab id). V1 deliberately does not preserve scroll / zoom / page
// position across tab switches.
//
// PreviewPane stays memoized on primitive props, so dragging the file/preview
// splitter (which re-renders App and this component) does NOT re-render the
// preview subtree — only a real change to the active tab's primitives does.

interface Props {
  agentId: string;
  tabs: PreviewTab[];
  activeTab: PreviewTab | null;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseLeft: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
}

/** Scroll `el` into view inside a horizontal scroller without touching ancestors. */
function scrollChildIntoStrip(strip: HTMLElement, el: HTMLElement, pad = 8) {
  // getBoundingClientRect is relative to the viewport; combining with the
  // scroller's current scrollLeft yields coordinates in scroll-content space.
  // offsetLeft is unreliable here (offsetParent may not be the strip).
  const elRect = el.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const left = strip.scrollLeft + (elRect.left - stripRect.left);
  const right = left + elRect.width;
  const viewLeft = strip.scrollLeft;
  const viewRight = viewLeft + strip.clientWidth;
  if (left < viewLeft + pad) {
    strip.scrollLeft = Math.max(0, left - pad);
  } else if (right > viewRight - pad) {
    strip.scrollLeft = right - strip.clientWidth + pad;
  }
}

/** Scroll a vertical list child into view inside its own scroller only. */
function scrollChildIntoList(list: HTMLElement, el: HTMLElement) {
  const elRect = el.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  const top = list.scrollTop + (elRect.top - listRect.top);
  const bottom = top + elRect.height;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

// Memoized: every prop is either a primitive (agentId, activeTabId) or a
// stable reference from usePreviewTabs (tabs, activeTab, onActivate,
// onClose). So during a splitter drag — which re-renders App and the parent
// split layout every animation frame — this component skips re-rendering
// entirely, and the memoized PreviewPane inside does too. It only re-renders
// when the tab set or active tab genuinely changes.
export const PreviewWorkspace = memo(function PreviewWorkspace({
  agentId, tabs, activeTab, activeTabId,
  onActivate, onClose, onCloseAll, onCloseLeft, onCloseRight,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);
  // Jump-to-tab dropdown: shown when 2+ tabs are open so a long strip can be
  // navigated without horizontal scrolling. Closed by outside click / Esc /
  // selecting a tab (or when the multi-tab strip itself unmounts).
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  // Keyboard / hover highlight in the picker. Not cleared on mouseleave of a
  // single option — that used to wipe keyboard selection when the cursor
  // drifted between rows.
  const [highlightedPickerId, setHighlightedPickerId] = useState<string | null>(null);
  // Fixed-position panel anchor (viewport coords). Absolute positioning under
  // the tab strip is clipped by ancestor overflow:hidden on the preview pane.
  const [pickerPos, setPickerPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);

  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabPickerRef = useRef<HTMLDivElement>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabElRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Latest values for the picker key handler — avoids re-binding global
  // listeners on every highlight change.
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const highlightedPickerIdRef = useRef(highlightedPickerId);
  const onActivateRef = useRef(onActivate);
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;
  highlightedPickerIdRef.current = highlightedPickerId;
  onActivateRef.current = onActivate;

  const dismissMenu = () => {
    setMenu(null);
    setHoveredMenuItem(null);
  };

  const dismissPicker = () => {
    setTabPickerOpen(false);
    setHighlightedPickerId(null);
    setPickerPos(null);
  };

  /** Measure trigger → fixed coords so the panel is never clipped. */
  const placePicker = () => {
    const trigger = pickerTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const top = rect.bottom + gap;
    const right = Math.max(8, window.innerWidth - rect.right);
    // Leave a comfortable bottom margin so the list scrolls inside the panel
    // rather than hanging off the viewport edge.
    const maxHeight = Math.max(160, Math.min(360, window.innerHeight - top - 12));
    setPickerPos({ top, right, maxHeight });
  };

  const openPicker = () => {
    dismissMenu();
    setTabPickerOpen(true);
    // Do not pre-seed a visual highlight on open — that read as a stuck
    // hover/shadow when the pointer never entered (or already left) the list.
    // Keyboard handlers still fall back to activeTabId when highlight is null.
    setHighlightedPickerId(null);
    placePicker();
  };

  const togglePicker = () => {
    if (tabPickerOpen) dismissPicker();
    else openPicker();
  };

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Capture + stop so App's Esc-to-close-tab handler does not fire.
        event.stopPropagation();
        event.preventDefault();
        dismissMenu();
      }
    };
    window.addEventListener('pointerdown', dismissMenu);
    window.addEventListener('blur', dismissMenu);
    window.addEventListener('resize', dismissMenu);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', dismissMenu);
      window.removeEventListener('blur', dismissMenu);
      window.removeEventListener('resize', dismissMenu);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menu]);

  // Outside click / Esc / arrow keys for the tab jump picker.
  useEffect(() => {
    if (!tabPickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const t = event.target as Node | null;
      if (tabPickerRef.current && t && tabPickerRef.current.contains(t)) return;
      dismissPicker();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        dismissPicker();
        pickerTriggerRef.current?.focus();
        return;
      }
      // Navigate the open listbox without requiring per-option focus.
      if (
        event.key !== 'ArrowDown' && event.key !== 'ArrowUp'
        && event.key !== 'Enter' && event.key !== 'Home' && event.key !== 'End'
      ) {
        return;
      }
      // Don't steal keys from form fields if focus somehow left the picker.
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      const list = tabsRef.current;
      if (list.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentId = highlightedPickerIdRef.current ?? activeTabIdRef.current;
      let idx = list.findIndex((t) => t.id === currentId);
      if (idx < 0) idx = 0;
      if (event.key === 'Enter') {
        const target = list[idx] ?? list[0];
        if (target) {
          dismissPicker();
          onActivateRef.current(target.id);
        }
        return;
      }
      let next = idx;
      if (event.key === 'ArrowDown') next = Math.min(list.length - 1, idx + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, idx - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = list.length - 1;
      const nextTab = list[next];
      if (!nextTab) return;
      setHighlightedPickerId(nextTab.id);
      const listEl = listRef.current;
      if (!listEl) return;
      for (const child of listEl.children) {
        if (child instanceof HTMLElement && child.dataset.tabId === nextTab.id) {
          scrollChildIntoList(listEl, child);
          break;
        }
      }
    };
    const onReposition = () => {
      // Keep the fixed panel glued to the trigger while the layout shifts
      // (splitter drag, window resize). Close if the multi-tab strip is gone.
      if (tabsRef.current.length < 2) {
        dismissPicker();
        return;
      }
      placePicker();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', dismissPicker);
    window.addEventListener('resize', onReposition);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', dismissPicker);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [tabPickerOpen]);

  // Drop floating UI when its target vanishes or multi-tab UI unmounts.
  useEffect(() => {
    if (tabs.length < 2) {
      setTabPickerOpen(false);
      setHighlightedPickerId(null);
      setPickerPos(null);
      setMenu(null);
      setHoveredMenuItem(null);
      return;
    }
    if (menu && !tabs.some((t) => t.id === menu.tabId)) {
      setMenu(null);
      setHoveredMenuItem(null);
    }
    // If the highlighted tab was closed while the picker is open, fall back
    // to the active tab so keyboard nav still has a valid anchor.
    if (
      tabPickerOpen
      && highlightedPickerId
      && !tabs.some((t) => t.id === highlightedPickerId)
    ) {
      setHighlightedPickerId(activeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when tab set / open UI ids change
  }, [tabs, menu?.tabId, tabPickerOpen, highlightedPickerId, activeTabId]);

  // Keep the active tab chip visible inside the strip only.
  useLayoutEffect(() => {
    if (!activeTabId) return;
    const strip = tabStripRef.current;
    const el = tabElRefs.current.get(activeTabId);
    if (!strip || !el) return;
    scrollChildIntoStrip(strip, el);
  }, [activeTabId, tabs.length]);

  // After open, scroll the active option into the list (seeded highlight).
  useLayoutEffect(() => {
    if (!tabPickerOpen || !highlightedPickerId) return;
    const listEl = listRef.current;
    if (!listEl) return;
    for (const child of listEl.children) {
      if (child instanceof HTMLElement && child.dataset.tabId === highlightedPickerId) {
        scrollChildIntoList(listEl, child);
        break;
      }
    }
  }, [tabPickerOpen, highlightedPickerId]);

  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const runMenuAction = (action: () => void) => {
    dismissMenu();
    action();
  };
  const menuItemStyle = (id: string, disabled = false) => ({
    ...styles.menuItem,
    ...(disabled ? styles.menuItemDisabled : hoveredMenuItem === id ? styles.menuItemHover : {}),
  });

  const activateFromPicker = (tabId: string) => {
    dismissPicker();
    onActivate(tabId);
  };

  return (
    <div style={styles.panel}>
      {tabs.length > 1 && (
        <div style={styles.tabBarRow}>
          <div
            ref={tabStripRef}
            style={styles.tabBar}
            role="tablist"
            aria-label="Open previews"
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  ref={(node) => {
                    if (node) tabElRefs.current.set(tab.id, node);
                    else tabElRefs.current.delete(tab.id);
                  }}
                  role="tab"
                  aria-selected={active}
                  onClick={() => onActivate(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    dismissPicker();
                    setHoveredMenuItem(null);
                    const menuWidth = 190;
                    const menuHeight = 150;
                    setMenu({
                      tabId: tab.id,
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
                    });
                  }}
                  // Full root + path as the tooltip; the visible label is just
                  // the basename so the strip stays compact.
                  title={`${tab.root}${tab.path}`}
                  style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}
                >
                  <span style={styles.tabTitle}>{tab.title}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                    title="Close tab"
                    aria-label={`Close ${tab.title}`}
                    style={styles.tabClose}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>
          {/* Jump-to-tab control: lists every open preview with basename +
              full path so the user can hop without hunting through a
              horizontally scrolled strip. */}
          <div ref={tabPickerRef} style={styles.tabPicker}>
            <button
              ref={pickerTriggerRef}
              type="button"
              onClick={togglePicker}
              style={{
                ...styles.tabPickerTrigger,
                ...(tabPickerOpen ? styles.tabPickerTriggerOpen : {}),
              }}
              aria-haspopup="listbox"
              aria-expanded={tabPickerOpen}
              title="Jump to open preview"
              aria-label={`Jump to open preview (${tabs.length})`}
            >
              <span style={styles.tabPickerCount}>{tabs.length}</span>
              <svg
                style={{
                  display: 'block',
                  transition: 'transform 0.15s',
                  transform: tabPickerOpen ? 'rotate(180deg)' : 'none',
                }}
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {tabPickerOpen && pickerPos && (
              <div
                style={{
                  ...styles.tabPickerPanel,
                  top: pickerPos.top,
                  right: pickerPos.right,
                  maxHeight: pickerPos.maxHeight,
                }}
                role="listbox"
                aria-label="Open previews"
                // Clear hover when leaving the whole panel (header + list).
                // Matches workspace root selector; avoids sticky hover chrome.
                onMouseLeave={() => setHighlightedPickerId(null)}
              >
                <div style={styles.tabPickerHeader}>
                  Open previews
                  <span style={styles.tabPickerHeaderCount}>{tabs.length}</span>
                </div>
                <div ref={listRef} style={styles.tabPickerList}>
                  {tabs.map((tab) => {
                    const active = tab.id === activeTabId;
                    // Hover / keyboard highlight is independent of the active
                    // tab so ↑/↓ does not switch previews until Enter/click.
                    // Selected wins over hover (shared menuListItemStyle).
                    const highlighted = highlightedPickerId === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="option"
                        data-tab-id={tab.id}
                        aria-selected={active}
                        title={`${tab.root}${tab.path}`}
                        style={menuListItemStyle({
                          selected: active,
                          hovered: highlighted,
                        })}
                        onMouseEnter={() => setHighlightedPickerId(tab.id)}
                        onClick={() => activateFromPicker(tab.id)}
                      >
                        <span style={menuList.itemTitle}>{tab.title}</span>
                        <span
                          style={menuListSubStyle(active, {
                            // File paths stay mono; root selector paths are
                            // plain sans — only typography differs.
                            fontFamily: font.mono,
                          })}
                        >
                          {tab.root}{tab.path}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {activeTab && (
        <>
          <div style={styles.header}>
            <span style={styles.path}>{activeTab.path}</span>
            <div style={styles.actions}>
              <a
                href={fileRawUrl(agentId, activeTab.root, activeTab.path)}
                download
                style={styles.downloadLink}
                title="Download"
              >
                Download
              </a>
              <button
                type="button"
                onClick={() => onClose(activeTab.id)}
                style={styles.closeBtn}
                title="Close (Esc)"
              >
                &times;
              </button>
            </div>
          </div>
          {/* Body wrapper gives PreviewPane a definite flex height so its own
              height:100% container resolves and internal scrolling works. */}
          <div style={styles.body}>
            <PreviewErrorBoundary key={activeTab.id}>
              <PreviewPane
                agentId={agentId}
                root={activeTab.root}
                path={activeTab.path}
                entryType={activeTab.entry.entry_type}
                denied={activeTab.entry.denied}
              />
            </PreviewErrorBoundary>
          </div>
        </>
      )}
      {menu && menuIndex !== -1 && (
        <div
          role="menu"
          aria-label="Tab actions"
          onPointerDown={(event) => event.stopPropagation()}
          style={{ ...styles.contextMenu, left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle('close')}
            onMouseEnter={() => setHoveredMenuItem('close')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(() => onClose(menu.tabId))}
          >
            Close tab
          </button>
          <div style={styles.menuDivider} />
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === 0}
            style={menuItemStyle('left', menuIndex === 0)}
            onMouseEnter={() => { if (menuIndex !== 0) setHoveredMenuItem('left'); }}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => {
              if (menuIndex === 0) return;
              runMenuAction(() => onCloseLeft(menu.tabId));
            }}
          >
            Close tabs to the left
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === tabs.length - 1}
            style={menuItemStyle('right', menuIndex === tabs.length - 1)}
            onMouseEnter={() => { if (menuIndex !== tabs.length - 1) setHoveredMenuItem('right'); }}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => {
              if (menuIndex === tabs.length - 1) return;
              runMenuAction(() => onCloseRight(menu.tabId));
            }}
          >
            Close tabs to the right
          </button>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle('all')}
            onMouseEnter={() => setHoveredMenuItem('all')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(onCloseAll)}
          >
            Close all tabs
          </button>
        </div>
      )}
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  panel: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  // ── Tab strip ──
  // Outer row pins the jump-picker on the right; the inner strip scrolls
  // independently so a long tab list never pushes the picker off-screen.
  // Only rendered with 2+ tabs so a single open preview looks identical to
  // the pre-tab layout.
  tabBarRow: {
    display: 'flex', alignItems: 'stretch', flexShrink: 0,
    borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
    minWidth: 0,
  },
  tabBar: {
    display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0,
    overflowX: 'auto', overflowY: 'hidden',
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px 6px 12px', cursor: 'pointer',
    maxWidth: 220, minWidth: 0, flexShrink: 0,
    borderRight: `1px solid ${c.border}`,
    color: c.textSecondary,
    transition: 'background 0.12s, color 0.12s',
    userSelect: 'none',
  },
  tabActive: {
    background: c.bg,
    color: c.text,
    // Thin accent underline marks the active tab without the visual weight of
    // a filled chip.
    boxShadow: `inset 0 2px 0 ${c.accent}`,
  },
  tabTitle: {
    flex: 1, minWidth: 0,
    fontSize: 12, fontFamily: font.sans,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  tabClose: {
    flexShrink: 0, background: 'none', border: 'none',
    color: c.textMuted, fontSize: 16, lineHeight: 1, cursor: 'pointer',
    padding: '0 2px', borderRadius: radius.sm,
  },
  // Jump-to-tab dropdown (right edge of multi-tab strip).
  tabPicker: {
    position: 'relative', flexShrink: 0,
    display: 'flex', alignItems: 'stretch',
    borderLeft: `1px solid ${c.border}`,
    background: c.bgSubtle,
  },
  tabPickerTrigger: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '0 10px', minWidth: 44,
    border: 'none', background: 'transparent',
    color: c.textSecondary, cursor: 'pointer',
    fontSize: 12, fontFamily: font.sans, fontWeight: 500,
    transition: 'background 0.12s, color 0.12s, box-shadow 0.12s',
  },
  // Open feedback aligned with the workspace root trigger (accent text + soft
  // ring) rather than the tab-strip inset bar — both custom listboxes then
  // open with the same accent language.
  tabPickerTriggerOpen: {
    background: c.bg,
    color: c.accent,
    boxShadow: `0 0 0 2px ${c.accentBg}`,
  },
  tabPickerCount: {
    fontVariantNumeric: 'tabular-nums',
    minWidth: 14, textAlign: 'center',
  },
  // position:fixed (coords set inline) so the panel escapes preview
  // overflow:hidden ancestors. Surface chrome from shared menuList.panel.
  tabPickerPanel: {
    ...menuList.panel,
    position: 'fixed', zIndex: 1000,
    width: 300, maxWidth: 'min(300px, calc(100vw - 24px))',
    // Override panel flex so header + scrollable list stack correctly.
    padding: 0, gap: 0, overflow: 'hidden',
  },
  tabPickerHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '8px 12px 6px', flexShrink: 0,
    fontSize: 11, fontWeight: 600, fontFamily: font.sans,
    color: c.textMuted, letterSpacing: '0.02em', textTransform: 'uppercase' as const,
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  tabPickerHeaderCount: {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500, textTransform: 'none' as const, letterSpacing: 0,
    color: c.textFaint,
  },
  tabPickerList: {
    // Same inset as menuList.panel padding so rows align with root selector.
    padding: 4, overflowY: 'auto', flex: 1, minHeight: 0,
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  // ── Active tab header ──
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '8px 16px', borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
    flexShrink: 0,
  },
  path: {
    color: c.textMuted, fontSize: 12, fontFamily: font.mono,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    flex: 1, minWidth: 0,
  },
  actions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  downloadLink: {
    color: c.textSecondary, fontSize: 12, textDecoration: 'none',
    padding: '4px 10px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: 'transparent',
    transition: 'all 0.15s',
  },
  closeBtn: {
    background: 'none', border: 'none', color: c.textMuted, fontSize: 18,
    cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
  },
  body: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  contextMenu: {
    position: 'fixed', zIndex: 1000, width: 190,
    padding: 4, border: `1px solid ${c.border}`, borderRadius: radius.md,
    background: c.surface, boxShadow: shadow.lg,
  },
  menuItem: {
    display: 'block', width: '100%', padding: '7px 10px',
    border: 'none', borderRadius: radius.sm, background: 'transparent',
    color: c.text, fontSize: 12, fontFamily: font.sans,
    textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  menuItemDisabled: { color: c.textMuted, cursor: 'default' },
  menuItemHover: { background: c.accentBg, color: c.accentHover },
  menuDivider: { height: 1, margin: '3px 6px', background: c.border },
};
