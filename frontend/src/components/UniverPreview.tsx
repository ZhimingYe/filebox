import { useCallback, useEffect, useRef, useState } from 'react';
import { fileRawAccessUrl } from '../api/client';
import { c } from '../theme';
import {
  getUniverPreviewKind,
  importDocxSnapshot,
  importXlsxSnapshot,
  loadRawFile,
  type RawFileLoadProgress,
  UniverPreviewError,
} from './univerPreviewSupport';
import { LoadingOverlay, styles } from './previewShared';

import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import docsEnUS from '@univerjs/preset-docs-core/locales/en-US';
import sheetsEnUS from '@univerjs/preset-sheets-core/locales/en-US';

interface Props {
  agentId: string;
  root: string;
  path: string;
}

type Phase =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

interface UniverRuntime {
  dispose: () => void;
}

type DebugData = Record<string, unknown>;

const READ_ONLY_KEYS = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  'F2',
  ' ',
]);

export function UniverPreview({ agentId, root, path }: Props) {
  const univerContainerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<UniverRuntime | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({
    kind: 'loading',
    message: 'Preparing Univer preview…',
  });

  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const error = describeDebugError(event.reason);
      // #region agent log
      writeDebugLog('C', 'UniverPreview.tsx:59', 'unhandled rejection observed while preview is mounted', error);
      // #endregion
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

  const disposeRuntime = useCallback(() => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;
    disposeRuntime();

    const updateProgress = ({ loaded, total }: RawFileLoadProgress) => {
      const suffix = total ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : ` (${formatBytes(loaded)})`;
      setPhase({ kind: 'loading', message: `Loading source document…${suffix}` });
    };

    const run = async () => {
      try {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const kind = getUniverPreviewKind(ext);
        if (!kind) throw new UniverPreviewError('file_unavailable', 'This format is not supported by Univer.');

        const url = await fileRawAccessUrl(agentId, root, path, controller.signal);
        const file = await loadRawFile(url, path.split('/').pop() || `preview.${ext}`, controller.signal, updateProgress);
        if (cancelled) return;

        setPhase({ kind: 'loading', message: 'Parsing source document…' });
        const runtime = await createRuntime(kind, file, univerContainerRef.current);
        if (cancelled) {
          runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        setPhase({ kind: 'ready' });
      } catch (error: unknown) {
        // #region agent log
        writeDebugLog('E', 'UniverPreview.tsx:100', 'preview run rejected', {
          cancelled,
          ...describeDebugError(error),
        });
        // #endregion
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Univer could not open this document.',
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
      disposeRuntime();
    };
  }, [agentId, root, path, disposeRuntime]);

  const cancelPreview = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    disposeRuntime();
    setPhase({ kind: 'error', message: 'Preview cancelled.' });
  }, [disposeRuntime]);

  return (
    <div
      style={{
        ...styles.container,
        display: 'block',
        overflow: 'hidden',
        background: c.bg,
        position: 'relative',
      }}
    >
      {/* Univer container - always mounted */}
      <div
        ref={univerContainerRef}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 0,
        }}
        onBeforeInputCapture={(event) => event.preventDefault()}
        onPasteCapture={(event) => event.preventDefault()}
        onCutCapture={(event) => event.preventDefault()}
        onDropCapture={(event) => event.preventDefault()}
        onKeyDownCapture={(event) => {
          if (READ_ONLY_KEYS.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) {
            event.preventDefault();
          }
        }}
      />
      {/* Overlay container - shown on top when loading or error */}
      {phase.kind !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {phase.kind === 'loading' && (
            <LoadingOverlay
              message={phase.message}
              onCancel={cancelPreview}
            />
          )}
          {phase.kind === 'error' && (
            <div style={styles.download}>
              <p style={styles.downloadText}>{phase.message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function createRuntime(
  kind: 'document' | 'spreadsheet',
  file: File,
  container: HTMLDivElement | null,
): Promise<UniverRuntime> {
  // #region agent log
  writeDebugLog('E', 'UniverPreview.tsx:188', 'createRuntime entry', {
    kind,
    fileBytes: file.size,
    containerPresent: Boolean(container),
  });
  // #endregion
  if (!container) throw new Error('Univer container is unavailable.');

  const [
    presets,
    docsPreset,
    sheetsPreset,
  ] = await Promise.all([
    import('@univerjs/presets'),
    import('@univerjs/preset-docs-core'),
    import('@univerjs/preset-sheets-core'),
  ]);
  const { createUniver, LocaleType } = presets;
  const { UniverDocsCorePreset } = docsPreset;
  const { UniverSheetsCorePreset } = sheetsPreset;
  // #region agent log
  writeDebugLog('B', 'UniverPreview.tsx:210', 'Univer modules loaded', {
    kind,
    presetsExports: Object.keys(presets).filter((key) => key !== 'default').sort(),
    docsPresetPresent: typeof UniverDocsCorePreset === 'function',
    sheetsPresetPresent: typeof UniverSheetsCorePreset === 'function',
  });
  // #endregion
  const locales = {
    [LocaleType.EN_US]: kind === 'document' ? docsEnUS : sheetsEnUS,
  };

  if (kind === 'document') {
    const snapshot = await importDocxSnapshot(file);
    const preset = UniverDocsCorePreset({
      container,
      header: false,
      footer: false,
      toolbar: false,
      contextMenu: false,
      disableAutoFocus: true,
    });
    // #region agent log
    writeDebugLog('A', 'UniverPreview.tsx:227', 'document preset and snapshot prepared', {
      pluginNames: describePresetPlugins(preset),
      dataStreamLength: snapshot.body?.dataStream?.length ?? 0,
      paragraphCount: snapshot.body?.paragraphs?.length ?? 0,
      textRunCount: snapshot.body?.textRuns?.length ?? 0,
    });
    // #endregion
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales,
      presets: [preset],
    });
    const createDocumentResult = univerAPI.createUniverDoc(snapshot);
    // #region agent log
    writeDebugLog('C', 'UniverPreview.tsx:247', 'document createUniver and API call returned', {
      apiMethods: Object.keys(univerAPI).sort(),
      univerMethods: Object.keys(univer).filter((key) => key !== 'injector').sort(),
      returnType: describeDebugValue(createDocumentResult),
    });
    // #endregion
    return { dispose: () => univer.dispose() };
  }

  const snapshot = await importXlsxSnapshot(file);
  const preset = UniverSheetsCorePreset({
    container,
    header: false,
    toolbar: false,
    formulaBar: false,
    footer: false,
    contextMenu: false,
    disableAutoFocus: true,
  });
  // #region agent log
  writeDebugLog('D', 'UniverPreview.tsx:270', 'spreadsheet preset and snapshot prepared', {
    pluginNames: describePresetPlugins(preset),
    sheetCount: snapshot.sheetOrder?.length ?? 0,
    sheetIds: snapshot.sheetOrder?.slice(0, 20) ?? [],
    workbookStyleCount: Object.keys(snapshot.styles ?? {}).length,
  });
  // #endregion
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales,
    presets: [preset],
  });
  const workbook = univerAPI.createWorkbook(snapshot);
  // #region agent log
  writeDebugLog('C', 'UniverPreview.tsx:286', 'spreadsheet createUniver and createWorkbook returned', {
    apiMethods: Object.keys(univerAPI).sort(),
    univerMethods: Object.keys(univer).filter((key) => key !== 'injector').sort(),
    returnType: describeDebugValue(workbook),
  });
  // #endregion
  await workbook.getWorkbookPermission().setReadOnly();
  workbook.disableSelection();
  return { dispose: () => univer.dispose() };
}

function describePresetPlugins(preset: unknown): string[] {
  if (!preset || typeof preset !== 'object') return [];
  const plugins = (preset as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((entry) => {
    const plugin = Array.isArray(entry) ? entry[0] : entry;
    if (typeof plugin !== 'function') return 'unknown';
    const namedPlugin = plugin as { pluginName?: unknown };
    return typeof namedPlugin.pluginName === 'string'
      ? namedPlugin.pluginName
      : plugin.name || 'anonymous';
  });
}

function describeDebugValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return value?.constructor?.name || 'object';
  return typeof value;
}

function describeDebugError(error: unknown): DebugData {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack || '',
    };
  }
  return { reasonType: typeof error, reason: String(error) };
}

function writeDebugLog(hypothesisId: string, location: string, message: string, data: DebugData): void {
  const payload = {
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  console.warn(`[filebox-debug] ${JSON.stringify(payload)}`);
  // #endregion
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
