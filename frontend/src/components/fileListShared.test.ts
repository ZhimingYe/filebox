import { expect, it } from 'vitest';
import { entryFromBasename, fileCategoryForName, fileExt, formatSize, isRecentlyModified, sortFileListRows } from './fileListShared';

it.each([['.env', '', null], ['README', '', null], ['a.', '', null], ['archive.tar.GZ', 'gz', 'archive'], ['图像.PNG', 'png', 'image'], ['data.CSV', 'csv', 'sheet'], ['a.unknown', 'unknown', null]])('classifies %s using its final extension', (name, ext, category) => {
  expect(fileExt(name)).toBe(ext);
  expect(fileCategoryForName(name)).toBe(category);
});
it.each([[0, '0 B'], [1023, '1023 B'], [1024, '1.0 KB'], [1536, '1.5 KB'], [1048576, '1.0 MB'], [1073741824, '1.0 GB']])('formats %i bytes', (bytes, label) => expect(formatSize(bytes)).toBe(label));
it.each([[900000, true], [900001, false], [-60000, true], [-60001, false]])('recent clock tolerates age %i at its inclusive boundaries', (age, expected) => {
  const now = Date.parse('2024-01-01T12:00:00Z');
  expect(isRecentlyModified(new Date(now - age).toISOString(), now)).toBe(expected);
});
it.each([null, undefined, '', 'bad'])('does not mark missing/invalid time %j recent', modified => expect(isRecentlyModified(modified, Date.now())).toBe(false));
it('creates independent synthetic entries preserving the basename', () => {
  const first = entryFromBasename('目录.csv');
  expect(first).toEqual({ name: '目录.csv', entry_type: 'file', size: null, modified: null, denied: false });
  first.name = 'changed';
  expect(entryFromBasename('目录.csv').name).toBe('目录.csv');
});
it.each(['name', 'size', 'modified', 'root'] as const)('sorts %s both directions without mutating input and keeps ties stable', key => {
  const rows = [
    { id: 'b', entry: { ...entryFromBasename('beta'), size: 20, modified: '2024-02-01' }, rootLabel: 'z' },
    { id: 'a', entry: { ...entryFromBasename('Alpha'), size: 10, modified: '2024-01-01' }, rootLabel: 'a' },
    { id: 'tie', entry: { ...entryFromBasename('alpha'), size: 10, modified: '2024-01-01' }, rootLabel: 'A' },
  ];
  const before = structuredClone(rows);
  expect(sortFileListRows(rows, key, true).map(row => row.id)).toEqual(['a', 'tie', 'b']);
  expect(sortFileListRows(rows, key, false).map(row => row.id)).toEqual(['b', 'a', 'tie']);
  expect(rows).toEqual(before);
});
it('sorts missing sizes and dates before populated values', () => {
  const rows = [{ entry: { ...entryFromBasename('full'), size: 1, modified: '2024-01-01' } }, { entry: entryFromBasename('missing') }];
  for (const key of ['size', 'modified'] as const) expect(sortFileListRows(rows, key, true)[0].entry.name).toBe('missing');
  expect(sortFileListRows([], 'name', true)).toEqual([]);
});
