import { expect, it } from 'vitest';
import { parseSgr } from './ansiSnapshot';
import { ansiColors, c } from '../theme';

it('renders plain and empty snapshots without markup interpretation', () => {
  expect(parseSgr('')).toEqual([]);
  expect(parseSgr('<script>hello</script>\n')[0].text).toBe('<script>hello</script>\n');
});

it('maps basic, bright, indexed and truecolor SGR and resets styles', () => {
  const runs = parseSgr('\x1b[31mred\x1b[94mblue\x1b[38;5;196mindex\x1b[48;2;12;180;90mrgb\x1b[0mplain');
  expect(runs.map(run => run.text)).toEqual(['red', 'blue', 'index', 'rgb', 'plain']);
  expect(runs[0].style.color).toBe(ansiColors[1]);
  expect(runs[1].style.color).toBe(ansiColors[12]);
  expect(runs[2].style.color).toBe('rgb(255, 0, 0)');
  expect(runs[3].style.backgroundColor).toBe('rgb(12, 180, 90)');
  expect(runs[4].style.color).toBeUndefined();
  expect(parseSgr('\x1b[38;5;232mx')[0].style.color).toBe('rgb(8, 8, 8)');
});

it('supports emphasis and inverse without leaking controls or OSC', () => {
  const runs = parseSgr('\x1b]2;title\x07\x1b[2J\x1b[1;2;3;4;7mx\x1b[22;23;24;27my');
  expect(runs.map(run => run.text).join('')).toBe('xy');
  expect(runs[0].style).toMatchObject({ fontWeight: 700, opacity: 0.6, fontStyle: 'italic', textDecoration: 'underline', color: c.bgSubtle, backgroundColor: c.text });
  expect(runs[1].style.fontWeight).toBeUndefined();
});

it('discards malformed and unfinished escapes and rejects invalid RGB', () => {
  expect(parseSgr('\x1b[38;2;999;0;0mtext')[0].style.color).toBeUndefined();
  expect(parseSgr('safe\x1b]unfinished').map(run => run.text).join('')).toBe('safe');
  expect(parseSgr('\x1b[999mtext\x1b[').map(run => run.text).join('')).toBe('text');
});
