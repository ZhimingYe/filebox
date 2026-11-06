import { expect, it } from 'vitest';
import { globToRegex } from './FileBrowser';

it.each([
  ['*report', 'report', true], ['*report', 'long-prefix-report', true],
  ['*.csv', '目录.csv', true], ['*.csv', 'aXcsv', false],
  ['a?.txt', 'ab.txt', true], ['a?.txt', 'abc.txt', false],
  ['file.(x)*', 'file.(x)123', true], ['file.(x)*', 'file.Ax123', false],
  ['^report[0-9]+$', 'report12', true], ['^report[0-9]+$', 'xreport12', false],
  ['', 'anything', true],
])('matches glob/regex %j against %j', (pattern, name, expected) => expect(new RegExp(globToRegex(pattern), 'i').test(name)).toBe(expected));
it('preserves invalid raw regex for the caller to report', () => {
  expect(() => new RegExp(globToRegex('['))).toThrow(SyntaxError);
});
