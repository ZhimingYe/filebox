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

const READ_ONLY_KEYS = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  'F2',
  ' ',
]);

export function UniverPreview({ agentId, root, path }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<UniverRuntime | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({
    kind: 'loading',
    message: 'Preparing Univer preview…',
  });

  const disposeRuntime = useCallback(() => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    if (containerRef.current) containerRef.current.replaceChildren();
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
        const runtime = await createRuntime(kind, file, containerRef.current);
        if (cancelled) {
          runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        setPhase({ kind: 'ready' });
      } catch (error: unknown) {
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

  if (phase.kind === 'loading') {
    return (
      <div style={styles.container}>
        <LoadingOverlay
          message={phase.message}
          onCancel={cancelPreview}
        />
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div style={styles.container}>
        <div style={styles.download}>
          <p style={styles.downloadText}>{phase.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        ...styles.container,
        display: 'block',
        overflow: 'hidden',
        background: c.bg,
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
  );
}

async function createRuntime(
  kind: 'document' | 'spreadsheet',
  file: File,
  container: HTMLDivElement | null,
): Promise<UniverRuntime> {
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

  if (kind === 'document') {
    const snapshot = await importDocxSnapshot(file);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      presets: [
        UniverDocsCorePreset({
          container,
          header: false,
          footer: false,
          toolbar: false,
          contextMenu: false,
          disableAutoFocus: true,
        }),
      ],
    });
    univerAPI.createUniverDoc(snapshot);
    return { dispose: () => univer.dispose() };
  }

  const snapshot = await importXlsxSnapshot(file);
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    presets: [
      UniverSheetsCorePreset({
        container,
        header: false,
        toolbar: false,
        formulaBar: false,
        footer: false,
        contextMenu: false,
        disableAutoFocus: true,
      }),
    ],
  });
  const workbook = univerAPI.createWorkbook(snapshot);
  await workbook.getWorkbookPermission().setReadOnly();
  workbook.disableSelection();
  return { dispose: () => univer.dispose() };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
