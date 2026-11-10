import type { CSSProperties } from 'react';
import { ansiIndexedColor, c } from '../theme';

export interface SgrRun { text: string; style: CSSProperties }

export function parseSgr(input: string): SgrRun[] {
  const runs: SgrRun[] = [];
  let fg: string | undefined, bg: string | undefined;
  let bold = false, dim = false, italic = false, underline = false, inverse = false;
  let text = '';
  const flush = () => {
    if (!text) return;
    runs.push({ text, style: {
      color: inverse ? bg ?? c.bgSubtle : fg,
      backgroundColor: inverse ? fg ?? c.text : bg,
      fontWeight: bold ? 700 : undefined, opacity: dim ? 0.6 : undefined,
      fontStyle: italic ? 'italic' : undefined, textDecoration: underline ? 'underline' : undefined,
    } });
    text = '';
  };
  for (let i = 0; i < input.length;) {
    if (input[i] !== '\x1b') {
      const ch = input[i++];
      if (ch === '\n' || ch === '\t' || ch.charCodeAt(0) >= 32) text += ch;
      continue;
    }
    flush();
    i++;
    if (input[i] === ']') {
      i++;
      while (i < input.length && input[i] !== '\x07' && !(input[i] === '\x1b' && input[i + 1] === '\\')) i++;
      i += input[i] === '\x07' ? 1 : 2;
      continue;
    }
    if (input[i] !== '[') { i++; continue; }
    const start = ++i;
    while (i < input.length && !/[@-~]/.test(input[i])) i++;
    const params = input.slice(start, i);
    if (input[i++] !== 'm' || !/^[\d;]*$/.test(params) || params.length > 256) continue;
    const codes = params.split(';').map(n => Number(n));
    for (let j = 0; j < codes.length; j++) {
      const code = codes[j];
      if (code === 0) { fg = bg = undefined; bold = dim = italic = underline = inverse = false; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 7) inverse = true;
      else if (code === 22) bold = dim = false;
      else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 27) inverse = false;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = ansiIndexedColor(code >= 90 ? code - 82 : code - 30);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = ansiIndexedColor(code >= 100 ? code - 92 : code - 40);
      else if (code === 38 || code === 48) {
        const mode = codes[++j];
        let color: string | undefined;
        if (mode === 5) {
          const n = codes[++j];
          if (Number.isInteger(n) && n >= 0 && n <= 255) color = ansiIndexedColor(n);
        } else if (mode === 2) {
          const rgb = codes.slice(j + 1, j + 4);
          j += 3;
          if (rgb.length === 3 && rgb.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) color = `rgb(${rgb.join(', ')})`;
        }
        if (color) { if (code === 38) fg = color; else bg = color; }
      }
    }
  }
  flush();
  return runs;
}
