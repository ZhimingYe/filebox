// Local Monaco bootstrap for the neo read-only code viewer.
// Imported only from the lazy CodeEditor chunk so the dock shell stays light.
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerQuartoLanguage } from './quartoLanguage'

let configured = false

export const NEO_MONACO_THEME = 'neo-dark'

export function ensureMonacoConfigured() {
  if (configured) return
  configured = true

  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        default:
          return new editorWorker()
      }
    },
  }

  loader.config({ monaco })
  registerQuartoLanguage(monaco)

  monaco.editor.defineTheme(NEO_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#12141a',
      'editor.foreground': '#e8e8ec',
      'editorLineNumber.foreground': '#6b7280',
      'editorLineNumber.activeForeground': '#9ca3af',
      'editor.lineHighlightBackground': '#181b24',
      'editorWidget.background': '#181b24',
      'editorWidget.border': '#2a2d38',
    },
  })
}
