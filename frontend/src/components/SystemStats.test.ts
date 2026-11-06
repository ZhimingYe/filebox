import { expect, it } from 'vitest';
import type { ProcessInfo, UserAgg } from '../api/client';
import { barColor, cmpProcs, cmpUsers, formatAgo, formatBoot, formatBytes, formatCount, formatCpuMs, formatDuration, isKernelThread, stateLabel } from './SystemStats';

const user: UserAgg = { user: 'alice', uid: 1, cpu_usage: 10, mem_bytes: 100, accumulated_cpu_ms: 1000, process_count: 2 };
const proc: ProcessInfo = { ...user, pid: 1, name: 'alpha', state: 'S', start_time: 0, run_time_secs: 10, parent_pid: null, command: '', nproc: null };
it.each(['cpu_usage', 'mem_bytes', 'accumulated_cpu_ms', 'process_count'] as const)('orders users descending by %s without mutation', key => {
  const higher = { ...user, [key]: user[key] + 1 };
  const before = structuredClone([user, higher]);
  expect(cmpUsers(user, higher, key, {}, {})).toBeGreaterThan(0);
  expect(cmpUsers(higher, user, key, {}, {})).toBeLessThan(0);
  expect([user, higher]).toEqual(before);
});
it.each(['cpu_share', 'mem_share'] as const)('uses supplied %s, including absent shares', key => {
  const other = { ...user, uid: 2 };
  expect(cmpUsers(user, other, key, { 2: 50 }, { 2: 50 })).toBeGreaterThan(0);
});
it('sorts user names and terminates ties for identical HPC jobs', () => {
  expect(cmpUsers(user, { ...user, user: 'bob' }, 'user', {}, {})).toBeLessThan(0);
  expect(cmpUsers(user, { ...user, uid: 2 }, 'cpu_usage', {}, {})).toBeGreaterThan(0);
  expect(cmpUsers(user, { ...user, cpu_usage: 20 }, 'mem_bytes', {}, {})).toBeGreaterThan(0);
  expect(cmpUsers(user, user, 'cpu_usage', {}, {})).toBe(0);
});
it.each(['cpu_usage', 'mem_bytes', 'accumulated_cpu_ms', 'run_time_secs'] as const)('orders processes descending by %s with stable pid ties', key => {
  expect(cmpProcs(proc, { ...proc, [key]: proc[key] + 1 }, key)).toBeGreaterThan(0);
  expect(cmpProcs(proc, { ...proc, pid: 2 }, key)).toBeLessThan(0);
  expect(cmpProcs(proc, proc, key)).toBe(0);
});
it('uses process names after user names and sorts names lexically', () => {
  expect(cmpProcs(proc, { ...proc, name: 'beta' }, 'user')).toBeLessThan(0);
  expect(cmpProcs(proc, { ...proc, user: 'bob' }, 'user')).toBeLessThan(0);
  expect(cmpProcs(proc, { ...proc, name: 'beta' }, 'name')).toBeLessThan(0);
});
it.each([
  [{ uid: 0, name: '[kworker]', command: '' }, true],
  [{ uid: 1, name: '[kworker]', command: '' }, false],
  [{ uid: 0, name: '[kworker]', command: 'user command' }, false],
  [{ uid: 0, name: 'daemon', command: '' }, false],
  [{ uid: 0, name: '[partial', command: '' }, false],
])('requires all kernel-thread signals: %j', (fields, expected) => expect(isKernelThread({ ...proc, ...fields })).toBe(expected));
it.each([[0, '0 B'], [1023, '1023 B'], [1024, '1 KB'], [1048576, '1.0 MB'], [1073741824, '1.00 GB'], [1099511627776, '1.00 TB']])('formats byte threshold %i', (n, expected) => expect(formatBytes(n)).toBe(expected));
it.each([[999, '999'], [1000, '1.0k'], [10000, '10k'], [1000000, '1.0M']])('formats count threshold %i', (n, expected) => expect(formatCount(n)).toBe(expected));
it.each([[59, '59s'], [60, '1m 0s'], [3599, '59m 59s'], [3600, '1h 0m'], [86400, '1d 0h']])('formats duration threshold %i', (n, expected) => expect(formatDuration(n)).toBe(expected));
it.each([[59000, '59s'], [60000, '1.0m'], [3600000, '1.0h'], [86400000, '1.0d']])('formats CPU time %i', (n, expected) => expect(formatCpuMs(n)).toBe(expected));
it.each([[4999, 'just now'], [5000, '5s ago'], [60000, '1m ago']])('formats age threshold %i', (n, expected) => expect(formatAgo(n)).toBe(expected));
it('converts boot seconds to local time and preserves unknown states', () => {
  expect(formatBoot(0)).toBe('—');
  expect(formatBoot(1700000000)).toBe(new Date(1700000000000).toLocaleString());
  expect(stateLabel('R')).toBe('Running');
  expect(stateLabel('Z')).toBe('Zombie');
  expect(stateLabel('custom')).toBe('custom');
});
it('changes severity only above warning and danger thresholds', () => {
  expect(barColor(60)).toBe(barColor(0));
  expect(barColor(60.1)).not.toBe(barColor(60));
  expect(barColor(80)).toBe(barColor(60.1));
  expect(barColor(80.1)).not.toBe(barColor(80));
});
