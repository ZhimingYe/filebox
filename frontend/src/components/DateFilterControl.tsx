import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { c, radius, font, shadow } from '../theme';

// ── Public types / filter helpers ──────────────────────────────────────────

/** Modification-date filter presets. `custom` uses after/before ISO days. */
export type DateFilterPreset =
  | 'any'
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | '90d'
  | '365d'
  | 'custom';

export interface DateFilterValue {
  preset: DateFilterPreset;
  /** Inclusive local start day `YYYY-MM-DD`, or empty for open lower bound. */
  after: string;
  /** Inclusive local end day `YYYY-MM-DD`, or empty for open upper bound. */
  before: string;
}

export const EMPTY_DATE_FILTER: DateFilterValue = {
  preset: 'any',
  after: '',
  before: '',
};

const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

type PresetOption = {
  id: Exclude<DateFilterPreset, 'custom'>;
  label: string;
  shortLabel: string;
  hint?: string;
};

const PRESET_OPTIONS: PresetOption[] = [
  { id: 'any', label: 'Any date', shortLabel: 'Any' },
  { id: 'today', label: 'Today', shortLabel: 'Today', hint: 'Local calendar day' },
  { id: 'yesterday', label: 'Yesterday', shortLabel: 'Yesterday' },
  { id: '7d', label: 'Last 7 days', shortLabel: '7 days' },
  { id: '30d', label: 'Last 30 days', shortLabel: '30 days' },
  { id: '90d', label: 'Last 90 days', shortLabel: '90 days' },
  { id: '365d', label: 'Last year', shortLabel: '1 year' },
];

// ── Date math (local calendar, never UTC-shift ISO days) ───────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

/** Parse `YYYY-MM-DD` as local midnight. Invalid → null. */
export function parseLocalDateInput(value: string): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  // Reject overflow dates (`2024-02-31` → Mar 2) that JS Date silently rolls.
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) {
    return null;
  }
  return d.getTime();
}

export function toIsoDay(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

export function todayIso(): string {
  const n = new Date();
  return toIsoDay(n.getFullYear(), n.getMonth(), n.getDate());
}

function addDaysIso(iso: string, delta: number): string | null {
  const t = parseLocalDateInput(iso);
  if (t === null) return null;
  const d = new Date(t);
  d.setDate(d.getDate() + delta);
  return toIsoDay(d.getFullYear(), d.getMonth(), d.getDate());
}

function compareIso(a: string, b: string): number {
  // Lexicographic works for zero-padded YYYY-MM-DD.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Pretty local day: "Jan 3" this year, "Jan 3, 2024" otherwise. */
export function formatLocalDayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const mon = MONTH_SHORT[month - 1] ?? m[2];
  if (year === new Date().getFullYear()) return `${mon} ${day}`;
  return `${mon} ${day}, ${year}`;
}

export function formatCustomRangeSummary(after: string, before: string): string {
  if (after && before) return `${formatLocalDayLabel(after)} – ${formatLocalDayLabel(before)}`;
  if (after) return `From ${formatLocalDayLabel(after)}`;
  if (before) return `Until ${formatLocalDayLabel(before)}`;
  return 'Custom range';
}

export function dateFilterTriggerLabel(value: DateFilterValue, compact: boolean): string {
  const { preset, after, before } = value;
  if (preset === 'any') return compact ? 'Date' : 'Any date';
  if (preset === 'today') return 'Today';
  if (preset === 'yesterday') return 'Yesterday';
  if (preset === '7d') return compact ? '7 days' : 'Last 7 days';
  if (preset === '30d') return compact ? '30 days' : 'Last 30 days';
  if (preset === '90d') return compact ? '90 days' : 'Last 90 days';
  if (preset === '365d') return compact ? '1 year' : 'Last year';
  return formatCustomRangeSummary(after, before);
}

/**
 * True when custom bounds are unusable: a non-empty side that does not parse
 * as a real local calendar day, or From strictly after To (same-day OK).
 */
export function isCustomDateRangeInvalid(after: string, before: string): boolean {
  if (after && parseLocalDateInput(after) === null) return true;
  if (before && parseLocalDateInput(before) === null) return true;
  if (!after || !before) return false;
  return compareIso(after, before) > 0;
}

export function isDateFilterActive(value: DateFilterValue): boolean {
  if (value.preset === 'any') return false;
  if (value.preset === 'custom') {
    if (!value.after && !value.before) return false;
    // Invalid or unparseable bounds never filter the list (and never show as
    // an "active" chip state).
    if (isCustomDateRangeInvalid(value.after, value.before)) return false;
  }
  return true;
}

/**
 * Whether an entry mtime falls in the active date filter window.
 * Missing/unparseable modified never matches an active filter.
 */
export function matchesDateFilter(
  modifiedIso: string | null | undefined,
  value: DateFilterValue,
): boolean {
  if (value.preset === 'any') return true;
  if (value.preset === 'custom' && !value.after && !value.before) return true;

  if (!modifiedIso) return false;
  const ms = new Date(modifiedIso).getTime();
  if (!Number.isFinite(ms)) return false;

  const now = new Date();
  let min = -Infinity;
  let max = Infinity;

  if (value.preset === 'today') {
    min = startOfLocalDay(now);
    max = endOfLocalDay(now);
  } else if (value.preset === 'yesterday') {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    min = startOfLocalDay(y);
    max = endOfLocalDay(y);
  } else if (value.preset === '7d') {
    // Inclusive local calendar windows (today + previous N-1 days), not a
    // rolling wall-clock duration — matches common "last N days" UX.
    min = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
    max = endOfLocalDay(now);
  } else if (value.preset === '30d') {
    min = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
    max = endOfLocalDay(now);
  } else if (value.preset === '90d') {
    min = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89));
    max = endOfLocalDay(now);
  } else if (value.preset === '365d') {
    min = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364));
    max = endOfLocalDay(now);
  } else if (value.preset === 'custom') {
    // Unparseable bound strings: treat as inactive open bound (never as
    // "match everything" via -Infinity/Infinity alone when the other side is
    // also broken — callers should gate on isDateFilterActive first).
    const after = parseLocalDateInput(value.after);
    const before = parseLocalDateInput(value.before);
    if (after === null && before === null && (value.after || value.before)) {
      return false;
    }
    if (after !== null) min = after;
    if (before !== null) max = endOfLocalDay(new Date(before));
  }

  return ms >= min && ms <= max;
}

// ── Calendar grid helpers ──────────────────────────────────────────────────

type MonthCursor = { year: number; month: number }; // month: 0-11

function monthFromIso(iso: string | null | undefined, fallback = new Date()): MonthCursor {
  if (iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (m) return { year: Number(m[1]), month: Number(m[2]) - 1 };
  }
  return { year: fallback.getFullYear(), month: fallback.getMonth() };
}

function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const d = new Date(cursor.year, cursor.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function buildMonthCells(year: number, month: number): Array<{ iso: string; day: number; inMonth: boolean } | null> {
  const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ iso: string; day: number; inMonth: boolean } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= days; day++) {
    cells.push({ iso: toIsoDay(year, month, day), day, inMonth: true });
  }
  // Pad to full weeks so the grid height is stable month-to-month.
  while (cells.length % 7 !== 0) cells.push(null);
  while (cells.length < 42) cells.push(null);
  return cells;
}

function isoInRange(iso: string, start: string, end: string): boolean {
  if (!start || !end) return false;
  const lo = compareIso(start, end) <= 0 ? start : end;
  const hi = compareIso(start, end) <= 0 ? end : start;
  return compareIso(iso, lo) >= 0 && compareIso(iso, hi) <= 0;
}

// ── Icons ──────────────────────────────────────────────────────────────────

function IconCalendar({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 6.5h11" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 2.5v2M10.5 2.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconChevron({ dir, size = 14 }: { dir: 'left' | 'right'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ display: 'block' }}
    >
      <path
        d={dir === 'left' ? 'M10 4L6 8l4 4' : 'M6 4l4 4-4 4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden style={{ display: 'block' }}>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  value: DateFilterValue;
  onChange: (next: DateFilterValue) => void;
  isMobile: boolean;
  /** Optional live match count shown in the panel footer. */
  matchCount?: number | null;
}

/**
 * Commercial-grade modification-date filter.
 *
 * Trigger chip + popover with quick presets and a real month calendar for
 * custom ranges (click start → click end, open bounds supported, hover
 * previews the provisional range). Filtering semantics live in the exported
 * helpers so the list can stay pure/memoized.
 */
export function DateFilterControl({ value, onChange, isMobile, matchCount = null }: Props) {
  const [open, setOpen] = useState(false);
  const [hoveredPreset, setHoveredPreset] = useState<string | null>(null);
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const [hoverTrigger, setHoverTrigger] = useState(false);
  const [navHover, setNavHover] = useState<'prev' | 'next' | null>(null);
  // Which bound the next calendar click writes. `after→before` is the default
  // range gesture; the From/To chips can pin either side for open bounds.
  const [focusBound, setFocusBound] = useState<'after' | 'before' | null>(null);
  const [cursor, setCursor] = useState<MonthCursor>(() =>
    monthFromIso(value.after || value.before || null),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const active = isDateFilterActive(value);
  const invalid = value.preset === 'custom' && isCustomDateRangeInvalid(value.after, value.before);
  const today = todayIso();

  // When opening, land the calendar on a relevant month and clear hover noise.
  useEffect(() => {
    if (!open) {
      setHoveredDay(null);
      setHoveredPreset(null);
      setFocusBound(null);
      return;
    }
    setCursor(monthFromIso(value.after || value.before || null));
    // Resume "pick the end" if a custom start is already set without an end.
    if (value.preset === 'custom' && value.after && !value.before) {
      setFocusBound('before');
    } else {
      setFocusBound(null);
    }
    // Focus the panel for Esc handling without stealing from other controls.
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
    // Only re-anchor when the open edge fires — not on every value change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside click / Escape / resize dismiss.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture + stop so App's Esc-to-close-tab does not also fire.
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const applyPreset = useCallback(
    (id: Exclude<DateFilterPreset, 'custom'>) => {
      // "Any date" wipes custom bounds. Other presets keep prior custom bounds
      // so re-entering Custom range is frictionless (presets ignore them).
      if (id === 'any') {
        onChange(EMPTY_DATE_FILTER);
      } else {
        onChange({
          preset: id,
          after: value.after,
          before: value.before,
        });
      }
      setFocusBound(null);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange, value.after, value.before],
  );

  const clearAll = useCallback(() => {
    onChange(EMPTY_DATE_FILTER);
    setFocusBound(null);
  }, [onChange]);

  const setCustomBounds = useCallback(
    (after: string, before: string) => {
      onChange({ preset: 'custom', after, before });
    },
    [onChange],
  );

  /**
   * Calendar day click — commercial range selection:
   *  - Default: first click = From (clears To), second = To (auto-ordered).
   *  - From/To chips pin the next write for open-ended bounds.
   *  - Third click (complete range already set, no pin) starts a new range.
   * Always switches preset to `custom`.
   */
  const onDayClick = useCallback(
    (iso: string) => {
      setCursor(monthFromIso(iso));

      // Explicit pin from the From / To chips.
      if (focusBound === 'after') {
        let before = value.preset === 'custom' ? value.before : '';
        if (before && compareIso(iso, before) > 0) before = '';
        setCustomBounds(iso, before);
        setFocusBound(before ? null : 'before');
        setHoveredDay(null);
        return;
      }
      if (focusBound === 'before') {
        let after = value.preset === 'custom' ? value.after : '';
        if (after && compareIso(iso, after) < 0) {
          // Clicked before the start → treat as new start of a range.
          setCustomBounds(iso, after);
        } else {
          setCustomBounds(after, iso);
        }
        setFocusBound(null);
        setHoveredDay(null);
        return;
      }

      // Default two-click range gesture.
      const isCustom = value.preset === 'custom';
      const hasAfter = isCustom && !!value.after;
      const hasBefore = isCustom && !!value.before;
      if (!hasAfter || hasBefore) {
        setCustomBounds(iso, '');
        setFocusBound('before');
        setHoveredDay(null);
        return;
      }
      // Completing the range from an existing start.
      if (compareIso(iso, value.after) < 0) {
        setCustomBounds(iso, value.after);
      } else {
        setCustomBounds(value.after, iso);
      }
      setFocusBound(null);
      setHoveredDay(null);
    },
    [focusBound, value.preset, value.after, value.before, setCustomBounds],
  );

  const cells = useMemo(
    () => buildMonthCells(cursor.year, cursor.month),
    [cursor.year, cursor.month],
  );

  // Provisional range while choosing the end day (hover preview).
  const previewingEnd =
    focusBound === 'before' &&
    value.preset === 'custom' &&
    !!value.after &&
    !value.before &&
    !!hoveredDay;
  const previewingStart =
    focusBound === 'after' &&
    value.preset === 'custom' &&
    !!value.before &&
    !value.after &&
    !!hoveredDay;
  const rangeStart =
    value.preset === 'custom'
      ? value.after || (previewingStart ? hoveredDay! : '')
      : '';
  const rangeEnd =
    value.preset === 'custom'
      ? value.before || (previewingEnd ? hoveredDay! : '')
      : '';

  const triggerTitle = active
    ? `Modified: ${dateFilterTriggerLabel(value, false)}`
    : 'Filter by modification date';

  const footerHint = (() => {
    if (invalid) return 'Start must be on or before end.';
    if (focusBound === 'after') {
      return value.before
        ? `End ${formatLocalDayLabel(value.before)} — click a start date`
        : 'Click a start date (open-ended From)';
    }
    if (focusBound === 'before') {
      return value.after
        ? `Start ${formatLocalDayLabel(value.after)} — click an end date`
        : 'Click an end date (open-ended Until)';
    }
    if (value.preset === 'custom' && (value.after || value.before)) {
      return formatCustomRangeSummary(value.after, value.before);
    }
    if (value.preset === 'custom') {
      return 'Click a start date, then an end date. Leave one side empty for open range.';
    }
    return 'Or pick days on the calendar for a custom range';
  })();

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  // ── Trigger ──────────────────────────────────────────────────────────────
  const triggerStyle: CSSProperties = {
    ...styles.trigger,
    ...(isMobile ? styles.triggerCompact : null),
    ...(hoverTrigger && !open && !active && !invalid ? styles.triggerHover : null),
    ...(open || active ? styles.triggerActive : null),
    ...(invalid ? styles.triggerInvalid : null),
  };

  return (
    <div ref={rootRef} style={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHoverTrigger(true)}
        onMouseLeave={() => setHoverTrigger(false)}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        style={triggerStyle}
      >
        <IconCalendar size={isMobile ? 13 : 14} />
        <span style={styles.triggerLabel}>
          {dateFilterTriggerLabel(value, isMobile)}
        </span>
        {active && !invalid && <span style={styles.triggerDot} aria-hidden />}
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          style={{
            display: 'block',
            flexShrink: 0,
            opacity: 0.65,
            transition: 'transform 0.15s ease',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
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

      {open && isMobile && (
        <div
          style={styles.backdrop}
          onClick={close}
          onKeyDown={() => {}}
          aria-hidden
        />
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Modification date filter"
          aria-modal={isMobile || undefined}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          style={{
            ...styles.panel,
            ...(isMobile ? styles.panelMobile : styles.panelDesktop),
          }}
        >
          {/* Header */}
          <div style={styles.header}>
            <div style={styles.headerLeft}>
              <span style={styles.headerTitle}>Modified</span>
              <span style={styles.headerSub}>Filter files by last modified time</span>
            </div>
            {(active || value.preset === 'custom' || value.after || value.before) && (
              <button type="button" style={styles.headerClear} onClick={clearAll}>
                Clear
              </button>
            )}
          </div>

          <div style={{ ...styles.body, ...(isMobile ? styles.bodyMobile : null) }}>
            {/* Presets */}
            <div
              style={{ ...styles.presetCol, ...(isMobile ? styles.presetColMobile : null) }}
              role="listbox"
              aria-label="Date presets"
            >
              {isMobile ? (
                <div style={styles.presetChips}>
                  {PRESET_OPTIONS.map((opt) => {
                    const selected = value.preset === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        style={{
                          ...styles.presetChip,
                          ...(selected ? styles.presetChipSelected : null),
                        }}
                        onClick={() => applyPreset(opt.id)}
                      >
                        {opt.shortLabel}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="option"
                    aria-selected={value.preset === 'custom'}
                    style={{
                      ...styles.presetChip,
                      ...(value.preset === 'custom' ? styles.presetChipSelected : null),
                    }}
                    onClick={() => {
                      onChange({
                        preset: 'custom',
                        after: value.after,
                        before: value.before,
                      });
                      setFocusBound(
                        value.after && !value.before
                          ? 'before'
                          : !value.after && value.before
                            ? 'after'
                            : null,
                      );
                    }}
                  >
                    Custom
                  </button>
                </div>
              ) : (
                <>
                  {PRESET_OPTIONS.map((opt) => {
                    const selected = value.preset === opt.id;
                    const hovered = hoveredPreset === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        style={{
                          ...styles.presetItem,
                          ...(hovered && !selected ? styles.presetItemHover : null),
                          ...(selected ? styles.presetItemSelected : null),
                        }}
                        onMouseEnter={() => setHoveredPreset(opt.id)}
                        onMouseLeave={() => setHoveredPreset(null)}
                        onClick={() => applyPreset(opt.id)}
                      >
                        <span style={styles.presetItemLabel}>{opt.label}</span>
                        {selected && (
                          <span style={styles.presetCheck}>
                            <IconCheck />
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <div style={styles.presetDivider} />
                  <button
                    type="button"
                    role="option"
                    aria-selected={value.preset === 'custom'}
                    style={{
                      ...styles.presetItem,
                      ...(hoveredPreset === 'custom' && value.preset !== 'custom'
                        ? styles.presetItemHover
                        : null),
                      ...(value.preset === 'custom' ? styles.presetItemSelected : null),
                    }}
                    onMouseEnter={() => setHoveredPreset('custom')}
                    onMouseLeave={() => setHoveredPreset(null)}
                    onClick={() => {
                      onChange({
                        preset: 'custom',
                        after: value.after,
                        before: value.before,
                      });
                      setFocusBound(
                        value.after && !value.before
                          ? 'before'
                          : !value.after && value.before
                            ? 'after'
                            : null,
                      );
                    }}
                  >
                    <span style={styles.presetItemLabel}>Custom range</span>
                    {value.preset === 'custom' && (
                      <span style={styles.presetCheck}>
                        <IconCheck />
                      </span>
                    )}
                  </button>
                </>
              )}
            </div>

            {/* Calendar */}
            <div style={{ ...styles.calCol, ...(isMobile ? styles.calColMobile : null) }}>
              <div style={styles.calHeader}>
                <button
                  type="button"
                  style={{
                    ...styles.calNavBtn,
                    ...(navHover === 'prev' ? styles.calNavBtnHover : null),
                  }}
                  aria-label="Previous month"
                  onMouseEnter={() => setNavHover('prev')}
                  onMouseLeave={() => setNavHover(null)}
                  onClick={() => setCursor((m) => shiftMonth(m, -1))}
                >
                  <IconChevron dir="left" />
                </button>
                <div style={styles.calMonthLabel}>
                  <span style={styles.calMonthName}>{MONTH_LONG[cursor.month]}</span>
                  <span style={styles.calYear}>{cursor.year}</span>
                </div>
                <button
                  type="button"
                  style={{
                    ...styles.calNavBtn,
                    ...(navHover === 'next' ? styles.calNavBtnHover : null),
                  }}
                  aria-label="Next month"
                  onMouseEnter={() => setNavHover('next')}
                  onMouseLeave={() => setNavHover(null)}
                  onClick={() => setCursor((m) => shiftMonth(m, 1))}
                >
                  <IconChevron dir="right" />
                </button>
              </div>

              <div style={styles.calWeekRow} aria-hidden>
                {WEEKDAYS.map((d) => (
                  <span key={d} style={styles.calWeekday}>
                    {d}
                  </span>
                ))}
              </div>

              <div
                style={styles.calGrid}
                role="grid"
                aria-label={`${MONTH_LONG[cursor.month]} ${cursor.year}`}
                onMouseLeave={() => setHoveredDay(null)}
              >
                {cells.map((cell, idx) => {
                  if (!cell) {
                    return <span key={`e-${idx}`} style={styles.calEmpty} />;
                  }
                  const isToday = cell.iso === today;
                  const isStart = rangeStart === cell.iso;
                  const isEnd = rangeEnd === cell.iso && !!rangeEnd;
                  const inRange =
                    !!rangeStart &&
                    !!rangeEnd &&
                    isoInRange(cell.iso, rangeStart, rangeEnd) &&
                    !isStart &&
                    !isEnd;
                  const isSingle = isStart && (isEnd || !rangeEnd);
                  const isHovered = hoveredDay === cell.iso;
                  // Edge rounding for range endpoints.
                  const rangeEdgeLeft =
                    isStart ||
                    (isEnd && rangeStart && compareIso(cell.iso, rangeStart) < 0);
                  const rangeEdgeRight =
                    isEnd ||
                    (isStart && rangeEnd && compareIso(cell.iso, rangeEnd) > 0) ||
                    (isStart && !rangeEnd);

                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      role="gridcell"
                      aria-label={cell.iso}
                      aria-selected={isStart || isEnd}
                      style={{
                        ...styles.calDay,
                        ...(inRange ? styles.calDayInRange : null),
                        ...(isStart || isEnd ? styles.calDayEndpoint : null),
                        ...(isSingle ? styles.calDaySingle : null),
                        // Soften range bar corners at the endpoints of a multi-day span.
                        ...(!isSingle && (isStart || isEnd) && rangeStart && rangeEnd
                          ? {
                              borderTopLeftRadius: rangeEdgeLeft ? radius.md : 0,
                              borderBottomLeftRadius: rangeEdgeLeft ? radius.md : 0,
                              borderTopRightRadius: rangeEdgeRight ? radius.md : 0,
                              borderBottomRightRadius: rangeEdgeRight ? radius.md : 0,
                            }
                          : null),
                      }}
                      onMouseEnter={() => setHoveredDay(cell.iso)}
                      onClick={(e: ReactMouseEvent) => {
                        e.preventDefault();
                        onDayClick(cell.iso);
                      }}
                      onDoubleClick={(e: ReactMouseEvent) => {
                        // Double-click locks a single calendar day (From = To).
                        e.preventDefault();
                        setCustomBounds(cell.iso, cell.iso);
                        setFocusBound(null);
                        setHoveredDay(null);
                        setCursor(monthFromIso(cell.iso));
                      }}
                    >
                      <span
                        style={{
                          ...styles.calDayNum,
                          ...((isStart || isEnd) ? styles.calDayNumEndpoint : null),
                          ...(isToday && !isStart && !isEnd ? styles.calDayNumToday : null),
                          ...(isHovered && !isStart && !isEnd && !inRange
                            ? styles.calDayNumHover
                            : null),
                          ...(isHovered && inRange ? styles.calDayNumHoverInRange : null),
                        }}
                      >
                        {cell.day}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Bound chips + shortcuts */}
              <div style={styles.boundRow}>
                <BoundChip
                  label="From"
                  iso={value.preset === 'custom' ? value.after : ''}
                  placeholder="Start"
                  active={focusBound === 'after'}
                  onClear={() => {
                    setCustomBounds('', value.preset === 'custom' ? value.before : '');
                    setFocusBound(value.before ? null : 'after');
                  }}
                  onClick={() => {
                    onChange({
                      preset: 'custom',
                      after: value.after,
                      before: value.before,
                    });
                    setFocusBound('after');
                  }}
                />
                <span style={styles.boundArrow} aria-hidden>
                  →
                </span>
                <BoundChip
                  label="To"
                  iso={value.preset === 'custom' ? value.before : ''}
                  placeholder="End"
                  active={focusBound === 'before'}
                  onClear={() => {
                    setCustomBounds(value.preset === 'custom' ? value.after : '', '');
                    setFocusBound(value.after ? 'before' : null);
                  }}
                  onClick={() => {
                    onChange({
                      preset: 'custom',
                      after: value.after,
                      before: value.before,
                    });
                    setFocusBound('before');
                  }}
                />
              </div>

              <div style={styles.shortcutRow}>
                <ShortcutButton
                  label="Today"
                  onClick={() => {
                    const t = todayIso();
                    setCustomBounds(t, t);
                    setFocusBound(null);
                    setCursor(monthFromIso(t));
                  }}
                />
                <ShortcutButton
                  label="Past week"
                  onClick={() => {
                    const end = todayIso();
                    const start = addDaysIso(end, -6);
                    if (start) {
                      setCustomBounds(start, end);
                      setFocusBound(null);
                      setCursor(monthFromIso(end));
                    }
                  }}
                />
                <ShortcutButton
                  label="This month"
                  onClick={() => {
                    const n = new Date();
                    const start = toIsoDay(n.getFullYear(), n.getMonth(), 1);
                    const end = todayIso();
                    setCustomBounds(start, end);
                    setFocusBound(null);
                    setCursor(monthFromIso(end));
                  }}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={styles.footer}>
            <p
              style={{
                ...styles.footerHint,
                ...(invalid ? styles.footerHintError : null),
              }}
              role={invalid ? 'alert' : undefined}
            >
              {footerHint}
            </p>
            <div style={styles.footerRight}>
              {matchCount != null && active && !invalid && (
                <span style={styles.footerCount}>
                  {matchCount} match{matchCount === 1 ? '' : 'es'}
                </span>
              )}
              {isMobile ? (
                <button type="button" style={styles.doneBtn} onClick={close}>
                  Done
                </button>
              ) : (
                <button type="button" style={styles.doneBtnQuiet} onClick={close}>
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bound chip ─────────────────────────────────────────────────────────────

function BoundChip({
  label,
  iso,
  placeholder,
  active,
  onClear,
  onClick,
}: {
  label: string;
  iso: string;
  placeholder: string;
  active: boolean;
  onClear: () => void;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        ...styles.boundChip,
        ...(active ? styles.boundChipActive : null),
        ...(hover && !active ? styles.boundChipHover : null),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button type="button" style={styles.boundChipMain} onClick={onClick}>
        <span style={styles.boundChipLabel}>{label}</span>
        <span style={{ ...styles.boundChipValue, ...(!iso ? styles.boundChipPlaceholder : null) }}>
          {iso ? formatLocalDayLabel(iso) : placeholder}
        </span>
      </button>
      {iso ? (
        <button
          type="button"
          style={styles.boundChipClear}
          aria-label={`Clear ${label.toLowerCase()} date`}
          title={`Clear ${label.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function ShortcutButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      style={{
        ...styles.shortcutBtn,
        ...(hover ? styles.shortcutBtnHover : null),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Styles (theme tokens only) ─────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    flexShrink: 1,
    minWidth: 0,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 55,
    background: c.bgOverlay,
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    maxWidth: 200,
    minWidth: 0,
    height: 30,
    padding: '0 8px 0 9px',
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12.5,
    fontFamily: font.sans,
    fontWeight: 500,
    outline: 'none',
    transition: 'border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s',
    boxSizing: 'border-box',
  },
  triggerCompact: {
    maxWidth: 132,
    padding: '0 6px 0 7px',
    gap: 4,
    fontSize: 12,
  },
  triggerHover: {
    borderColor: c.textFaint,
    background: c.bgSubtle,
    color: c.text,
  },
  triggerActive: {
    borderColor: c.accent,
    background: c.accentBg,
    color: c.accent,
    boxShadow: `0 0 0 2px ${c.accentBg}`,
  },
  triggerInvalid: {
    borderColor: c.danger,
    background: c.dangerBg,
    color: c.danger,
    boxShadow: `0 0 0 2px ${c.dangerBg}`,
  },
  triggerLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1 1 auto',
    minWidth: 0,
    textAlign: 'left',
  },
  triggerDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    background: 'currentColor',
    flexShrink: 0,
    opacity: 0.85,
  },

  panel: {
    zIndex: 60,
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.lg,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    outline: 'none',
    overflow: 'hidden',
  },
  panelDesktop: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    width: 456,
  },
  panelMobile: {
    position: 'fixed',
    left: 12,
    right: 12,
    top: 'max(56px, 8vh)',
    width: 'auto',
    maxWidth: 440,
    margin: '0 auto',
    maxHeight: 'min(80vh, 640px)',
    overflowY: 'auto',
  },

  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 14px 10px',
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  headerLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
    letterSpacing: '-0.01em',
  },
  headerSub: {
    fontSize: 11.5,
    color: c.textMuted,
    fontFamily: font.sans,
    lineHeight: 1.3,
  },
  headerClear: {
    border: 'none',
    background: 'transparent',
    color: c.accent,
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: radius.sm,
    flexShrink: 0,
  },

  body: {
    display: 'flex',
    flexDirection: 'row',
    minHeight: 0,
  },
  bodyMobile: {
    flexDirection: 'column',
  },

  presetCol: {
    width: 148,
    flexShrink: 0,
    padding: '8px 6px',
    borderRight: `1px solid ${c.borderSubtle}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    background: c.bgSubtle,
  },
  presetColMobile: {
    width: 'auto',
    borderRight: 'none',
    borderBottom: `1px solid ${c.borderSubtle}`,
    padding: '10px 12px',
    background: c.surface,
  },
  presetChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  presetChip: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.textSecondary,
    borderRadius: radius.pill,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    lineHeight: 1.2,
  },
  presetChipSelected: {
    borderColor: c.accent,
    background: c.accentBg,
    color: c.accent,
  },
  presetItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    padding: '7px 10px',
    borderRadius: radius.md,
    border: 'none',
    background: 'transparent',
    color: c.text,
    cursor: 'pointer',
    fontFamily: font.sans,
    textAlign: 'left',
    boxSizing: 'border-box',
  },
  presetItemHover: {
    background: c.bgMuted,
  },
  presetItemSelected: {
    background: c.accentBg,
    color: c.accent,
    fontWeight: 500,
  },
  presetItemLabel: {
    fontSize: 12.5,
    lineHeight: 1.25,
    minWidth: 0,
  },
  presetCheck: {
    color: c.accent,
    flexShrink: 0,
    display: 'flex',
  },
  presetDivider: {
    height: 1,
    background: c.border,
    margin: '6px 8px',
    opacity: 0.7,
  },

  calCol: {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  calColMobile: {
    padding: '12px 14px 10px',
  },
  calHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '0 2px 2px',
  },
  calNavBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.textSecondary,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
  },
  calNavBtnHover: {
    background: c.bgMuted,
    borderColor: c.textFaint,
    color: c.text,
  },
  calMonthLabel: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    fontFamily: font.sans,
  },
  calMonthName: {
    fontSize: 13.5,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.01em',
  },
  calYear: {
    fontSize: 12.5,
    fontWeight: 500,
    color: c.textMuted,
  },
  calWeekRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: 0,
    padding: '0 0 2px',
  },
  calWeekday: {
    textAlign: 'center',
    fontSize: 10.5,
    fontWeight: 600,
    color: c.textMuted,
    fontFamily: font.sans,
    letterSpacing: '0.02em',
    padding: '2px 0',
    userSelect: 'none',
  },
  calGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '2px 0',
  },
  calEmpty: {
    height: 32,
  },
  calDay: {
    height: 32,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: font.sans,
    position: 'relative',
    borderRadius: 0,
  },
  calDayInRange: {
    background: c.accentBg,
  },
  calDayEndpoint: {
    background: c.accentBg,
  },
  calDaySingle: {
    background: 'transparent',
  },
  calDayNum: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12.5,
    fontWeight: 500,
    color: c.text,
    transition: 'background 0.1s, color 0.1s, box-shadow 0.1s',
  },
  calDayNumHover: {
    background: c.bgMuted,
  },
  calDayNumHoverInRange: {
    background: c.accentBg,
    boxShadow: `inset 0 0 0 1px ${c.accent}55`,
  },
  calDayNumEndpoint: {
    background: c.accent,
    color: '#fff',
    fontWeight: 600,
    boxShadow: `0 1px 2px ${c.accent}55`,
  },
  calDayNumToday: {
    boxShadow: `inset 0 0 0 1.5px ${c.accent}`,
    color: c.accent,
    fontWeight: 600,
  },

  boundRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  boundArrow: {
    color: c.textFaint,
    fontSize: 12,
    flexShrink: 0,
    userSelect: 'none',
  },
  boundChip: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.bgSubtle,
    padding: '2px 2px 2px 0',
    boxSizing: 'border-box',
    transition: 'border-color 0.12s, background 0.12s, box-shadow 0.12s',
  },
  boundChipHover: {
    borderColor: c.textFaint,
    background: c.surface,
  },
  boundChipActive: {
    borderColor: c.accent,
    background: c.accentBg,
    boxShadow: `0 0 0 2px ${c.accentBg}`,
  },
  boundChipMain: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: '4px 8px',
    textAlign: 'left',
    fontFamily: font.sans,
  },
  boundChipLabel: {
    fontSize: 9.5,
    fontWeight: 600,
    color: c.textMuted,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    lineHeight: 1.2,
  },
  boundChipValue: {
    fontSize: 12.5,
    fontWeight: 500,
    color: c.text,
    lineHeight: 1.25,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    width: '100%',
  },
  boundChipPlaceholder: {
    color: c.textMuted,
    fontWeight: 400,
  },
  boundChipClear: {
    width: 22,
    height: 22,
    border: 'none',
    borderRadius: radius.sm,
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
    marginRight: 2,
  },

  shortcutRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  shortcutBtn: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.surface,
    color: c.textSecondary,
    borderRadius: radius.pill,
    padding: '4px 10px',
    fontSize: 11.5,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    lineHeight: 1.2,
    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
  },
  shortcutBtnHover: {
    background: c.bgMuted,
    borderColor: c.textFaint,
    color: c.text,
  },

  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 14px 12px',
    borderTop: `1px solid ${c.borderSubtle}`,
    background: c.bgSubtle,
  },
  footerHint: {
    margin: 0,
    flex: 1,
    minWidth: 0,
    fontSize: 11.5,
    lineHeight: 1.35,
    color: c.textMuted,
    fontFamily: font.sans,
  },
  footerHintError: {
    color: c.danger,
    fontWeight: 500,
  },
  footerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  footerCount: {
    fontSize: 11.5,
    color: c.textMuted,
    fontFamily: font.sans,
    fontVariantNumeric: 'tabular-nums',
  },
  doneBtn: {
    height: 30,
    padding: '0 14px',
    border: 'none',
    borderRadius: radius.md,
    background: c.accent,
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: font.sans,
    cursor: 'pointer',
  },
  doneBtnQuiet: {
    height: 28,
    padding: '0 10px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    borderRadius: radius.md,
    background: c.surface,
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
  },
};
