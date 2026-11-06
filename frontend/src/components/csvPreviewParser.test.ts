import { describe, expect, it } from 'vitest';
import { detectCsvDelimiter, parseCsvPreview } from './csvPreviewParser';

describe('CSV records', () => {
  it.each([
    ['', [], 0],
    ['a,b\r\n"c,d","say ""hi"""\r\n', [['a', 'b'], ['c,d', 'say "hi"']], 2],
    ['"a\r\nb",c\n\n', [['a\nb', 'c']], 1],
    ['a,\n\nb,c', [['a', ''], [''], ['b', 'c']], 3],
  ])('parses %j without confusing fields and records', (text, rows, total) => {
    expect(parseCsvPreview(text, ',')).toMatchObject({ rows, totalRecords: total });
  });
  it('retains raw multiline records and counts beyond the preview limit', () => {
    const text = ['"a\nb",c', ...Array.from({ length: 101 }, (_, i) => `${i},x`)].join('\n');
    const parsed = parseCsvPreview(text, ',');
    expect(parsed.rows).toHaveLength(100);
    expect(parsed.rawRecords[0]).toBe('"a\nb",c');
    expect(parsed.rows.at(-1)).toEqual(['98', 'x']);
    expect(parsed.totalRecords).toBe(102);
  });
  it.each([
    ['"a,b,c";d\n1;2', ',', ';'],
    ['a\tb\n1\t2', ',', '\t'],
    ['plain', '|', '|'],
    ['a,b;c', ';', ';'],
    [Array(5).fill('a;b').join('\n') + '\nx,y,z,w', ',', ';'],
  ])('detects delimiters outside quotes in %j', (text, fallback, expected) => {
    expect(detectCsvDelimiter(text, fallback)).toBe(expected);
  });
});
