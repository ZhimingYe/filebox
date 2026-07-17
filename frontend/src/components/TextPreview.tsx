import { useState, useRef, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';

import { ensureMonacoConfigured, MONACO_THEME, monacoFontFamily } from '../monacoSetup';
import {
  useFetchText,
  useFileGate,
  FileGateError,
  LargeFileWarning,
  PREVIEW_SIZE_THRESHOLDS,
  CopyButton,
  LoadingOverlay,
  wrapPref,
  setWrapPref,
  extToLang,
  styles,
} from './previewShared';

ensureMonacoConfigured();

interface Props {
  url: string;
  ext: string;
  agentId: string;
  root: string;
  path: string;
}

export function TextPreview({ url, ext, agentId, root, path }: Props) {
  const gate = useFileGate({ agentId, root, path, threshold: PREVIEW_SIZE_THRESHOLDS.text });
  const canLoad = !gate.sizeUnknown && !gate.error && (!gate.isLarge || gate.bypassed);
  const { text, error, loading, cancel, retry } = useFetchText(url, canLoad);
  const [wrap, setWrap] = useState(wrapPref);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  // Keep word-wrap in sync when the toolbar toggle flips after mount.
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
  }, [wrap]);

  if (gate.sizeUnknown) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Checking file size..." />
      </div>
    );
  }
  if (gate.error) return <FileGateError message={gate.error} onRetry={gate.retry} />;
  if (gate.isLarge && !gate.bypassed) {
    return (
      <LargeFileWarning
        size={gate.size!}
        flavor="file"
        onForceLoad={gate.forceLoad}
        url={url}
      />
    );
  }

  const toggleWrap = () => {
    const next = !wrap;
    setWrapPref(next);
    setWrap(next);
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <LoadingOverlay message="Loading file..." onCancel={cancel} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.largeImageWarning}>
          <p style={styles.errorText}>{error}</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={retry} style={styles.retryBtn}>Retry</button>
            <a href={url} download style={styles.downloadLink}>Download</a>
          </div>
        </div>
      </div>
    );
  }

  const raw = text!;
  const totalLines = raw.split('\n').length;
  const lang = extToLang[ext] || 'plaintext';

  const handleMount: OnMount = (ed, monacoInstance) => {
    editorRef.current = ed;
    ed.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
    // The floating find widget adds little value in a read-only viewer and
    // visually collides with our own toolbar, so keep it from ever opening
    // (Ctrl/Cmd+F, right-click menu) — see the `.find-widget` CSS override
    // below for the belt-and-suspenders visual hide.
    ed.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyF, () => {});
  };

  return (
    <div style={styles.monacoContainer}>
      <div style={styles.codeToolbar}>
        <span style={styles.metaInfo}>
          {totalLines.toLocaleString()} lines · {raw.length.toLocaleString()} chars · {lang}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={toggleWrap} style={styles.toolBtn}>
            {wrap ? 'Wrap: On' : 'Wrap: Off'}
          </button>
          <CopyButton text={raw} />
        </div>
      </div>
      <div style={styles.monacoEditorHost} className="filebox-monaco-preview">
        <Editor
          height="100%"
          language={lang}
          value={raw}
          theme={MONACO_THEME}
          onMount={handleMount}
          loading={<LoadingOverlay message="Loading editor..." />}
          options={{
            readOnly: true,
            domReadOnly: true,
            wordWrap: wrap ? 'on' : 'off',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontFamily: monacoFontFamily,
            fontSize: 13,
            lineHeight: 20,
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            folding: true,
            renderLineHighlight: 'line',
            contextmenu: true,
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            parameterHints: { enabled: false },
            // Read-only viewer: hover tooltips add little value here, so
            // keep them off (see also the disabled find widget below).
            hover: { enabled: false },
            links: true,
            // Read-only: hide the cursor caret blink noise; selection still works.
            cursorStyle: 'line-thin',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
          }}
        />
      </div>
    </div>
  );
}
