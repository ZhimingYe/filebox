import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { ensureMonacoConfigured, NEO_MONACO_THEME } from '../monaco/monacoSetup'
import {
  clearViewerState,
  getViewerState,
  setViewerState,
} from './previewKeepAlive'

ensureMonacoConfigured()

type Props = {
  text: string
  lang: string
  stateKey: string
  pinned: boolean
}

/** Lazy chunk: Monaco + workers load only when a code file is opened. */
export default function CodeEditor({ text, lang, stateKey, pinned }: Props) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  // Cache the latest view state: by unmount time the editor may already be
  // disposed (same detached-DOM trap as scroll containers).
  const viewStateRef = useRef<MonacoEditor.ICodeEditorViewState | null>(null)
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  useEffect(() => {
    return () => {
      const vs = editorRef.current?.saveViewState() ?? viewStateRef.current
      if (pinnedRef.current && vs) {
        setViewerState(stateKey, { kind: 'monaco', viewState: vs })
      } else if (!pinnedRef.current) {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey])

  const onMount: OnMount = (ed) => {
    editorRef.current = ed
    const saved = getViewerState(stateKey)
    if (saved?.kind === 'monaco' && saved.viewState) {
      ed.restoreViewState(saved.viewState as MonacoEditor.ICodeEditorViewState)
    }
    const remember = () => {
      viewStateRef.current = ed.saveViewState()
    }
    ed.onDidScrollChange(remember)
    ed.onDidChangeCursorPosition(remember)
    remember()
  }

  return (
    <Editor
      height="100%"
      language={lang}
      value={text}
      theme={NEO_MONACO_THEME}
      onMount={onMount}
      loading={<p className="neo-panel__muted">Loading editor…</p>}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: 20,
        automaticLayout: true,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false },
        hover: { enabled: false },
        overviewRulerLanes: 0,
        cursorStyle: 'line-thin',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  )
}
