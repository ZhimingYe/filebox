import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react'
import { FileTreePanel } from './panels/FileTreePanel'
import { PreviewPanel } from './panels/PreviewPanel'
import { fetchHubHealth, type HubHealth } from './hubStatus'
import { WorkspaceProvider } from './state/workspace'

const components = {
  fileTree: (_props: IDockviewPanelProps) => <FileTreePanel />,
  preview: (props: IDockviewPanelProps) => <PreviewPanel {...props} />,
}

function NeoShell() {
  const [health, setHealth] = useState<HubHealth>({
    ok: false,
    detail: 'Checking Hub…',
  })
  const abortRef = useRef<AbortController | null>(null)
  const apiRef = useRef<DockviewApi | null>(null)
  const previewSeq = useRef(1)

  const refreshHealth = useCallback(async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const next = await fetchHubHealth(ac.signal)
    if (!ac.signal.aborted) setHealth(next)
  }, [])

  useEffect(() => {
    void refreshHealth()
    const id = window.setInterval(() => void refreshHealth(), 15_000)
    return () => {
      window.clearInterval(id)
      abortRef.current?.abort()
    }
  }, [refreshHealth])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const { api } = event
    apiRef.current = api
    api.addPanel({
      id: 'file-tree',
      component: 'fileTree',
      title: 'Files',
      initialWidth: 320,
    })
    api.addPanel({
      id: 'preview-1',
      component: 'preview',
      title: 'Preview 1',
      position: { referencePanel: 'file-tree', direction: 'right' },
    })
  }, [])

  const addPreviewPanel = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    previewSeq.current += 1
    const n = previewSeq.current
    const id = `preview-${n}`
    // Prefer side-by-side so both Preview hosts stay mounted (dual-PDF gate).
    // 'within' makes a dockview tab and typically unmounts the inactive panel.
    const ref =
      api.getPanel('preview-1') ? 'preview-1' : api.panels.find((x) => x.id.startsWith('preview-'))?.id
    api.addPanel({
      id,
      component: 'preview',
      title: `Preview ${n}`,
      position: ref
        ? { referencePanel: ref, direction: 'right' }
        : undefined,
    })
  }, [])

  return (
    <div className="neo-shell">
      <header className="neo-topbar">
        <div className="neo-topbar__brand">
          <strong>filebox neo</strong>
          <span className="neo-topbar__badge">experimental</span>
        </div>
        <div className="neo-topbar__meta">
          <button type="button" className="neo-topbar__btn" onClick={addPreviewPanel}>
            + Preview panel
          </button>
          <span
            className={
              health.ok ? 'neo-topbar__status ok' : 'neo-topbar__status bad'
            }
            title="Probes /api/health (same origin via Hub or Vite proxy)"
          >
            {health.detail}
          </span>
          <a className="neo-topbar__link" href="/">
            Classic UI
          </a>
        </div>
      </header>
      <main className="neo-dock">
        <DockviewReact
          theme={themeDark}
          components={components}
          onReady={onReady}
          className="neo-dockview"
        />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <WorkspaceProvider>
      <NeoShell />
    </WorkspaceProvider>
  )
}
