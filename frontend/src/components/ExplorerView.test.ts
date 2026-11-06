import { expect, it } from 'vitest';
import { entryFromBasename } from './fileListShared';
import { appendExplorerEntries, childPath, compareExplorerEntries, displayPath, isSameOrDescendant, mergeSortedEntries, nodeKey, normalizePinPath, parentPath, sortedExplorerEntries, splitNodeKey, totalCachedEntries, trimCollapsedCache } from './ExplorerView';

const entry = (name: string, directory = false, modified: string | null = null) => ({ ...entryFromBasename(name), entry_type: directory ? 'directory' as const : 'file' as const, modified });
it('joins and splits root-relative paths without confusing root names', () => {
  expect(splitNodeKey(nodeKey('a:b', '/目录'))).toEqual({ root: 'a:b', path: '/目录' });
  expect(childPath('/', 'a')).toBe('/a');
  expect(childPath('/a', 'b')).toBe('/a/b');
  expect(parentPath('/a/b')).toBe('/a');
  expect(parentPath('/')).toBe('/');
  expect(displayPath('/', '/')).toBe('/');
  expect(displayPath('/home/u///', '/a')).toBe('/home/u/a');
  expect(normalizePinPath('a///')).toBe('/a');
  expect(normalizePinPath('')).toBe('/');
});
it.each([['r', '/a', true], ['r', '/a/b', true], ['r', '/ab', false], ['other', '/a/b', false]])('checks descendant %s:%s by path component', (root, path, expected) => {
  expect(isSameOrDescendant(nodeKey(root, path), 'r', '/a')).toBe(expected);
});
it('recognizes all descendants of the same root only', () => {
  expect(isSameOrDescendant(nodeKey('r', '/x'), 'r', '/')).toBe(true);
  expect(isSameOrDescendant(nodeKey('s', '/x'), 'r', '/')).toBe(false);
});
it.each([true, false])('keeps directories first and missing dates last (ascending=%s)', asc => {
  const dir = entry('z', true);
  const valid = entry('valid', false, '2024-01-01');
  const missing = entry('missing');
  const bad = entry('bad', false, 'invalid');
  expect(compareExplorerEntries(dir, valid, 'name', asc)).toBeLessThan(0);
  expect(compareExplorerEntries(valid, missing, 'modified', asc)).toBeLessThan(0);
  expect(compareExplorerEntries(valid, bad, 'modified', asc)).toBeLessThan(0);
});
it('sorts numeric names stably without mutating pages and merges appended pages', () => {
  const left = [entry('file10'), entry('file2'), entry('folder', true)];
  const right = [entry('file1'), entry('FILE2')];
  const before = structuredClone([left, right]);
  const combined = appendExplorerEntries(left, right);
  expect(sortedExplorerEntries(combined, 'name', true).map(e => e.name)).toEqual(['folder', 'file1', 'file2', 'FILE2', 'file10']);
  expect(sortedExplorerEntries(combined, 'name', false).map(e => e.name)).toEqual(['folder', 'file10', 'file2', 'FILE2', 'file1']);
  const sortedLeft = sortedExplorerEntries(left, 'name', true);
  const sortedRight = sortedExplorerEntries(right, 'name', true);
  expect(mergeSortedEntries(sortedLeft, sortedRight, 'name', true)).toEqual(sortedExplorerEntries(combined, 'name', true));
  expect(mergeSortedEntries([], sortedRight, 'name', true)).toEqual(sortedRight);
  expect([left, right]).toEqual(before);
});
const directory = (count: number, lastUsed: number) => ({
  items: Array.from({ length: count }, (_, i) => entry(String(i))), lastUsed,
  nextCursor: null, loading: false, loadPhase: null, loadMode: null, loaded: true,
  error: null, errorRetryable: false, errorAppend: false,
});
it('evicts least-recent collapsed directories, never expanded directories', () => {
  const nodes = new Map(Array.from({ length: 65 }, (_, i) => [String(i), directory(1, i)] as const));
  trimCollapsedCache(nodes, new Set(['0']));
  expect(nodes.size).toBe(64);
  expect(nodes.has('0')).toBe(true);
  expect(nodes.has('1')).toBe(false);
  expect(totalCachedEntries(nodes)).toBe(64);
});
it('enforces entry budget independently and terminates when every directory is expanded', () => {
  const nodes = new Map([['a', directory(10000, 0)], ['b', directory(10000, 1)]]);
  expect(trimCollapsedCache(nodes, new Set()).size).toBe(2);
  nodes.set('c', directory(1, 2));
  trimCollapsedCache(nodes, new Set(['a']));
  expect([...nodes.keys()]).toEqual(['a', 'c']);
  const expanded = new Map([['a', directory(20001, 0)]]);
  expect(trimCollapsedCache(expanded, new Set(['a'])).size).toBe(1);
  expect(trimCollapsedCache(new Map(), new Set()).size).toBe(0);
});
