/**
 * Neo preview dock panel — mounts classic PreviewPane (+ lazy viewers)
 * via the `@classic` Vite alias. One file per dockview panel; multi-file
 * is multiple panels / tabs. Pin/keep-alive park from classic
 * PreviewWorkspace is not rehosted here yet (dockview + pin registry later).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { PreviewPane } from '@classic/components/PreviewPane';
import { PreviewErrorBoundary } from '@classic/components/PreviewErrorBoundary';
import { c, font } from '../theme';
import { rememberFocusedPreview } from '../preview/openInDock';
import {
  basenamePath,
  previewPanelHasFile,
  type PreviewPanelParams,
} from '../preview/types';

export function PreviewPanel(props: IDockviewPanelProps<PreviewPanelParams>) {
  const { api, containerApi, params: initialParams } = props;
  const [params, setParams] = useState<PreviewPanelParams>(() => initialParams ?? {});

  useEffect(() => {
    const d = api.onDidParametersChange((next) => {
      setParams((next ?? {}) as PreviewPanelParams);
    });
    return () => d.dispose();
  }, [api]);

  useEffect(() => {
    const d = api.onDidActiveChange((ev) => {
      if (ev.isActive) rememberFocusedPreview(api.id);
    });
    if (api.isActive) rememberFocusedPreview(api.id);
    return () => d.dispose();
  }, [api]);

  const hasFile = previewPanelHasFile(params);

  const onRefresh = useCallback(() => {
    if (!hasFile) return;
    const nextRev = (params.rev ?? 0) + 1;
    api.updateParameters({ ...params, rev: nextRev });
  }, [api, hasFile, params]);

  const onPopout = useCallback(() => {
    const panel = containerApi.getPanel(api.id);
    if (panel) void containerApi.addPopoutGroup(panel);
  }, [api, containerApi]);

  const onClear = useCallback(() => {
    api.updateParameters({});
    api.setTitle('Preview');
  }, [api]);

  return (
    <div style={shellStyle}>
      <div style={toolbarStyle}>
        <div style={pathStyle} title={hasFile ? `${params.root}:${params.path}` : undefined}>
          {hasFile ? (
            <>
              <span style={{ color: c.textMuted }}>{params.root}</span>
              <span style={{ color: c.textMuted }}>:</span>
              <span>{params.path}</span>
            </>
          ) : (
            <span style={{ color: c.textMuted }}>No file open</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {hasFile ? (
            <>
              <button type="button" style={btnStyle} onClick={onRefresh} title="Reload preview">
                Refresh
              </button>
              <button type="button" style={btnStyle} onClick={onClear} title="Clear this panel">
                Clear
              </button>
            </>
          ) : null}
          <button
            type="button"
            style={btnStyle}
            onClick={onPopout}
            title="Pop out to a same-origin window (dockview addPopoutGroup)"
          >
            Pop out
          </button>
        </div>
      </div>
      <div style={bodyStyle}>
        {hasFile ? (
          <PreviewErrorBoundary label={`Preview ${basenamePath(params.path!)}`}>
            <PreviewPane
              key={`${params.agentId}:${params.root}:${params.path}:${params.rev ?? 0}`}
              agentId={params.agentId!}
              root={params.root!}
              path={params.path!}
              entryType={params.entryType ?? 'file'}
              denied={!!params.denied}
              officeCapable={!!params.officeCapable}
              rev={params.rev}
              stateKey={`${api.id}@${params.rev ?? 0}`}
            />
          </PreviewErrorBoundary>
        ) : (
          <div style={emptyStyle}>
            <div style={{ fontWeight: 600, color: c.text, marginBottom: 6 }}>Preview</div>
            <div style={{ color: c.textMuted, lineHeight: 1.5 }}>
              Select a file in Files to open it here. Classic{' '}
              <code style={{ fontFamily: font.mono }}>PreviewPane</code> viewers
              (PDF, HTML, Monaco, image, CSV, Markdown, Office) load on demand.
              Open another file to add a second preview tab, or use{' '}
              <strong>New Preview</strong> in the header.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const shellStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: c.bg,
  color: c.text,
  fontFamily: font.sans,
  fontSize: 13,
  minHeight: 0,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderBottom: `1px solid ${c.border}`,
  background: c.surface,
  flexShrink: 0,
  minHeight: 32,
};

const pathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: font.mono,
  fontSize: 11,
  color: c.text,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  overflow: 'hidden',
};

const emptyStyle: CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  padding: 16,
  color: c.textSecondary,
};

const btnStyle: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.bgMuted,
  color: c.textSecondary,
  cursor: 'pointer',
};
