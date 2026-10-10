import { useCallback, useEffect, useState } from 'react'
import { fsList, getAgents, type AgentInfo, type FsEntry } from '../api/hub'
import { useWorkspace } from '../state/workspace'

function joinPath(dir: string, name: string): string {
  if (!dir || dir === '/') return `/${name}`
  return `${dir.replace(/\/$/, '')}/${name}`
}

export function FileTreePanel() {
  const { openFile } = useWorkspace()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentId, setAgentId] = useState<string>('')
  const [root, setRoot] = useState<string>('')
  const [path, setPath] = useState('/')
  const [items, setItems] = useState<FsEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const list = await getAgents(ac.signal)
        if (ac.signal.aborted) return
        setAgents(list)
        const first = list.find((a) => a.roots.some((r) => r.enabled)) ?? list[0]
        if (first) {
          setAgentId(first.id)
          const r = first.roots.find((x) => x.enabled) ?? first.roots[0]
          if (r) setRoot(r.name)
        }
      } catch (e) {
        if (ac.signal.aborted) return
        const status = e && typeof e === 'object' && 'status' in e ? (e as { status?: number }).status : undefined
        setError(status === 401 ? 'Not logged in — open Classic UI first.' : 'Failed to load agents.')
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    })()
    return () => ac.abort()
  }, [])

  const refresh = useCallback(async () => {
    if (!agentId || !root) return
    setLoading(true)
    setError(null)
    try {
      const res = await fsList(agentId, root, path)
      setItems(res.items ?? [])
      if (res.error) setError(res.error)
    } catch (e) {
      const status = e && typeof e === 'object' && 'status' in e ? (e as { status?: number }).status : undefined
      setError(status === 401 ? 'Not logged in — open Classic UI first.' : 'List failed.')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [agentId, root, path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const agent = agents.find((a) => a.id === agentId)

  return (
    <div className="neo-panel">
      <header className="neo-panel__header">File tree</header>
      <div className="neo-tree-toolbar">
        <select
          value={agentId}
          onChange={(e) => {
            const id = e.target.value
            setAgentId(id)
            const a = agents.find((x) => x.id === id)
            const r = a?.roots.find((x) => x.enabled) ?? a?.roots[0]
            setRoot(r?.name ?? '')
            setPath('/')
          }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id} ({a.status})
            </option>
          ))}
        </select>
        <select
          value={root}
          onChange={(e) => {
            setRoot(e.target.value)
            setPath('/')
          }}
        >
          {(agent?.roots ?? []).map((r) => (
            <option key={r.name} value={r.name} disabled={!r.enabled}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="neo-tree-path">
        <button type="button" disabled={path === '/'} onClick={() => setPath(parentPath(path))}>
          ↑
        </button>
        <code>{path}</code>
      </div>
      <div className="neo-panel__body neo-tree-list">
        {loading && <p className="neo-panel__muted">Loading…</p>}
        {error && <p className="neo-panel__muted">{error}</p>}
        {!loading &&
          !error &&
          items.map((item) => (
            <button
              key={`${item.entry_type}:${item.name}`}
              type="button"
              className="neo-tree-row"
              disabled={item.denied}
              onClick={() => {
                if (item.entry_type === 'directory') {
                  setPath(joinPath(path, item.name))
                  return
                }
                openFile({ agentId, root, path: joinPath(path, item.name) })
              }}
            >
              <span className="neo-tree-row__kind">
                {item.entry_type === 'directory' ? 'dir' : 'file'}
              </span>
              <span className="neo-tree-row__name">{item.name}</span>
            </button>
          ))}
      </div>
    </div>
  )
}

function parentPath(p: string): string {
  if (!p || p === '/') return '/'
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? `/${parts.join('/')}` : '/'
}
