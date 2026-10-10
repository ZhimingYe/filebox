import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react'
import { FileTreePanel } from './panels/FileTreePanel'
import { PreviewPanel } from './panels/PreviewPanel'
import { fetchHubHealth, type HubHealth } from './hubStatus'

const components = {
  fileTree: (_props: IDockviewPanelProps) => <FileTreePanel />,
  preview: (_props: IDockviewPanelProps) => <PreviewPanel />,
}

function App() {
  const [health, setHealth] = useState<HubHealth>({
    ok: false,
    detail: 'Checking Hub…',
  })
  const abortRef = useRef<AbortController | null>(null)

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
    api.addPanel({
      id: 'file-tree',
      component: 'fileTree',
      title: 'Files',
      initialWidth: 320,
    })
    api.addPanel({
      id: 'preview',
      component: 'preview',
      title: 'Preview',
      position: { referencePanel: 'file-tree', direction: 'right' },
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

export default App
