// Local Monaco bootstrap for the read-only code viewer.
// Bundles monaco-editor instead of loading from a CDN (hub may be offline /
// air-gapped). Workers are registered so language-labelled models (TS/JSON/…)
// don't fall over; diagnostics / IntelliSense stay disabled in the editor
// options used by TextPreview.

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { c, font } from './theme';

let configured = false;

export const MONACO_THEME = 'filebox-light';

export function ensureMonacoConfigured() {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });

  monaco.editor.defineTheme(MONACO_THEME, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': c.bg,
      'editor.foreground': c.text,
      'editorLineNumber.foreground': c.textMuted,
      'editorLineNumber.activeForeground': c.textSecondary,
      'editor.selectionBackground': c.accentBg,
      'editor.inactiveSelectionBackground': c.bgMuted,
      'editor.lineHighlightBackground': c.bgSubtle,
      'editorCursor.foreground': c.accent,
      'editorWidget.background': c.surface,
      'editorWidget.border': c.border,
      'editorSuggestWidget.background': c.surface,
      'editorSuggestWidget.border': c.border,
      'editorFindMatchBackground': c.accentBg,
      'editorFindMatchHighlightBackground': c.bgMuted,
      'scrollbarSlider.background': c.border,
      'scrollbarSlider.hoverBackground': c.textFaint,
    },
  });
}

export const monacoFontFamily = font.mono;
