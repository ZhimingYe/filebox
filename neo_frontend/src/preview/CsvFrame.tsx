import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchFileRawText } from '../api/hub'
import {
  clearViewerState,
  getViewerState,
  setViewerState,
  viewerStateKey,
} from './previewKeepAlive'
import { detectCsvDelimiter, parseCsvPreview } from './csvPreviewParser'

type Props = {
  agentId: string
  root: string
  path: string
  tabId: string
  pinned: boolean
  ext: string
}

const CSV_EXTS = new Set(['csv', 'tsv'])

export function isCsvExt(ext: string): boolean {
  return CSV_EXTS.has(ext.toLowerCase())
}

export function CsvFrame({ agentId, root, path, tabId, pinned, ext }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateKey = viewerStateKey(tabId, 0)
  const saved = getViewerState(stateKey)
  const [view, setView] = useState<'table' | 'raw'>(
    saved?.kind === 'csv' ? saved.view : 'table',
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const ac = new AbortController()
    setText(null)
    setError(null)
    void (async () => {
      try {
        const body = await fetchFileRawText(agentId, root, path, ac.signal)
        if (!ac.signal.aborted) setText(body)
      } catch (e) {
        if (ac.signal.aborted) return
        const msg =
          e && typeof e === 'object' && 'error' in e
            ? String((e as { error?: string }).error)
            : 'preview_failed'
        setError(msg)
      }
    })()
    return () => ac.abort()
  }, [agentId, root, path])

  useEffect(() => {
    if (!text) return
    const el = scrollRef.current
    if (!el) return
    const s = getViewerState(stateKey)
    if (s?.kind === 'csv') el.scrollTop = s.scrollTop
    return () => {
      if (pinned) {
        setViewerState(stateKey, {
          kind: 'csv',
          scrollTop: el.scrollTop,
          view: viewRef.current,
        })
      } else {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey, text, pinned])

  const parsed = useMemo(() => {
    if (!text) return null
    const fallback = ext.toLowerCase() === 'tsv' ? '\t' : ','
    const delim = detectCsvDelimiter(text, fallback)
    return parseCsvPreview(text, delim)
  }, [text, ext])

  if (error) return <p className="neo-panel__muted">CSV failed: {error}</p>
  if (text == null) return <p className="neo-panel__muted">Loading CSV…</p>

  return (
    <div className="neo-csv-host">
      <div className="neo-image-toolbar">
        <button
          type="button"
          className={view === 'table' ? 'neo-tab--active' : undefined}
          onClick={() => setView('table')}
        >
          Table
        </button>
        <button
          type="button"
          className={view === 'raw' ? 'neo-tab--active' : undefined}
          onClick={() => setView('raw')}
        >
          Raw
        </button>
        {parsed && (
          <span className="neo-image-zoom">
            showing {parsed.rows.length}/{parsed.totalRecords} rows
          </span>
        )}
      </div>
      <div className="neo-csv-stage" ref={scrollRef}>
        {view === 'raw' ? (
          <pre className="neo-csv-raw">{text.slice(0, 200_000)}</pre>
        ) : (
          <table className="neo-csv-table">
            <tbody>
              {parsed?.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
