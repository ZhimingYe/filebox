import { expect, it } from 'vitest';
import type { SearchHit } from '../api/client';
import { clampContext, hitMatchesFilter, isValidIgnoreName, normalizeFolderPath, parseIgnoreList, parseMaxDepth } from './WorkspaceSearch';

it.each(['', '.', '..', 'a/b', '*.js', 'a?', '[a]', 'a\\b', 'a\0b', 'a\tb', 'x'.repeat(129)])('rejects invalid exact ignore name %j', name => expect(isValidIgnoreName(name)).toBe(false));
it.each(['.cache', '目录', 'node_modules', 'x'.repeat(128)])('accepts exact component %s', name => expect(isValidIgnoreName(name)).toBe(true));
it('normalizes separators, deduplicates case-insensitively and counts only rejected names', () => {
  expect(parseIgnoreList(' /venv/, VENV\n目录, .., a/b, *.js, ,')).toEqual({ names: ['venv', '目录'], dropped: 3, truncated: false });
  expect(parseIgnoreList(' , \n')).toEqual({ names: [], dropped: 0, truncated: false });
});
it('bounds ignore input and number of names', () => {
  const result = parseIgnoreList(Array.from({ length: 130 }, (_, i) => 'dir' + i).join(','));
  expect(result.names).toHaveLength(128);
  expect(result.names.at(-1)).toBe('dir127');
  expect(result.dropped).toBe(2);
  expect(parseIgnoreList('a,'.repeat(4097)).truncated).toBe(true);
});
it.each([['', null], ['0', null], ['-1', null], ['Infinity', null], ['bad', null], [' 3.9 ', 3], ['256', 256], ['999', 256]])('parses depth %j', (raw, expected) => expect(parseMaxDepth(raw)).toBe(expected));
it.each([[' ', '/'], ['.', '/'], ['./', '/'], ['./目录///', '/目录'], ['dir/', '/dir'], ['/dir///', '/dir']])('normalizes folder %j', (raw, expected) => expect(normalizeFolderPath(raw)).toBe(expected));
it.each([[NaN, 10], [Infinity, 10], [-1, 0], [2.9, 2], [20, 20], [21, 20]])('clamps context %s', (raw, expected) => expect(clampContext(raw)).toBe(expected));
it.each([[' ', true], ['REPORT', true], ['ROOT', true], ['世界', true], ['absent', false]])('filters path/root/context for %j', (needle, expected) => {
  const hit = { root: 'Root', path: '/report.txt', context: [{ text: 'Hello 世界' }] } as SearchHit;
  expect(hitMatchesFilter(hit, needle)).toBe(expected);
  expect(hitMatchesFilter({ ...hit, context: [] }, 'absent')).toBe(false);
});
