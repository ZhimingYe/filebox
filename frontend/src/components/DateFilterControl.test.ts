import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addDaysIso, buildMonthCells, dateFilterTriggerLabel, formatCustomRangeSummary, formatLocalDayLabel, isCustomDateRangeInvalid, isDateFilterActive, isoInRange, matchesDateFilter, parseLocalDateInput, shiftMonth, todayIso, toIsoDay, type DateFilterPreset } from './DateFilterControl';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2024, 2, 10, 12)); });
afterEach(() => vi.useRealTimers());
it.each(['', '2023-02-29', '2024-02-30', '2024-13-01', '2024-00-01', '2024-1-01', 'junk'])('rejects invalid local day %j', input => {
  expect(parseLocalDateInput(input)).toBeNull();
});
it('uses local calendar dates and leap/year rollover', () => {
  expect(parseLocalDateInput('2024-02-29')).toBe(new Date(2024, 1, 29).getTime());
  expect(todayIso()).toBe('2024-03-10');
  expect(toIsoDay(2024, 0, 3)).toBe('2024-01-03');
  expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
  expect(addDaysIso('2024-12-31', 1)).toBe('2025-01-01');
  expect(addDaysIso('bad', 1)).toBeNull();
  expect(shiftMonth({ year: 2024, month: 0 }, -1)).toEqual({ year: 2023, month: 11 });
});
it.each<[DateFilterPreset, number]>([['today', 0], ['7d', 6], ['30d', 29], ['90d', 89], ['365d', 364]])('includes both local-day boundaries for %s', (preset, days) => {
  const value = { preset, after: '', before: '' };
  const start = new Date(2024, 2, 10 - days).getTime();
  const end = new Date(2024, 2, 10, 23, 59, 59, 999).getTime();
  for (const time of [start, end]) expect(matchesDateFilter(new Date(time).toISOString(), value)).toBe(true);
  for (const time of [start - 1, end + 1]) expect(matchesDateFilter(new Date(time).toISOString(), value)).toBe(false);
});
it('handles yesterday and custom open/equal/invalid ranges', () => {
  const yesterday = { preset: 'yesterday' as const, after: '', before: '' };
  expect(matchesDateFilter(new Date(2024, 2, 9, 23, 59).toISOString(), yesterday)).toBe(true);
  expect(matchesDateFilter(new Date(2024, 2, 10).toISOString(), yesterday)).toBe(false);
  expect(matchesDateFilter(null, { ...yesterday, preset: 'any' })).toBe(true);
  expect(matchesDateFilter('bad', yesterday)).toBe(false);
  const custom = { preset: 'custom' as const, after: '2024-03-10', before: '2024-03-10' };
  expect(isDateFilterActive(custom)).toBe(true);
  expect(matchesDateFilter(new Date(2024, 2, 10, 23, 59, 59, 999).toISOString(), custom)).toBe(true);
  expect(matchesDateFilter('2025-01-01', { ...custom, before: '' })).toBe(true);
  expect(isDateFilterActive({ ...custom, after: '', before: '' })).toBe(false);
  expect(isCustomDateRangeInvalid('2024-03-11', '2024-03-10')).toBe(true);
  expect(isCustomDateRangeInvalid('bad', '')).toBe(true);
  expect(isCustomDateRangeInvalid('', '2024-03-10')).toBe(false);
});
it('builds a leap-month grid without duplicate or overflow days', () => {
  const cells = buildMonthCells(2024, 1);
  expect(cells).toHaveLength(42);
  expect(cells.slice(0, 4)).toEqual([null, null, null, null]);
  expect(cells[4]).toEqual({ iso: '2024-02-01', day: 1, inMonth: true });
  expect(cells.filter(Boolean)).toHaveLength(29);
  expect(cells[32]?.iso).toBe('2024-02-29');
  expect(cells.slice(33).every(cell => cell === null)).toBe(true);
});
it('treats range endpoints inclusively regardless of selection order', () => {
  for (const day of ['2024-03-01', '2024-03-02', '2024-03-03']) expect(isoInRange(day, '2024-03-03', '2024-03-01')).toBe(true);
  expect(isoInRange('2024-03-04', '2024-03-03', '2024-03-01')).toBe(false);
  expect(isoInRange('2024-03-01', '', '2024-03-03')).toBe(false);
});
it('labels local ranges without losing open bounds or older years', () => {
  expect(formatLocalDayLabel('2024-01-03')).toBe('Jan 3');
  expect(formatLocalDayLabel('2023-01-03')).toBe('Jan 3, 2023');
  expect(formatLocalDayLabel('bad')).toBe('bad');
  expect(formatCustomRangeSummary('', '2024-01-03')).toBe('Until Jan 3');
  expect(formatCustomRangeSummary('2024-01-03', '')).toBe('From Jan 3');
  expect(dateFilterTriggerLabel({ preset: '7d', after: '', before: '' }, true)).toBe('7 days');
});
