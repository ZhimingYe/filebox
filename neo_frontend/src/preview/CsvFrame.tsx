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
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stateKey = viewerStateKey(tabId, 0)
  const saved = getViewerState(stateKey)
  const [view, setView] = useState<'table' | 'raw'>(
    saved?.kind === 'csv' ? saved.view : 'table',
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  // Passive-effect cleanup on unmount runs after the DOM node is detached
  // (scrollTop reads 0), so track the live scroll position via onScroll.
  const scrollTopRef = useRef(0)
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  useEffect(() => {
    const ac = new AbortController()
    setText(null)
    setError(null)
    void (async () => {
      try {
        const body = await fetchFileRawText(agentId, root, path, ac.signal)
        if (!ac.signal.aborted) {
          setText(body.text)
          setTruncated(body.truncated)
        }
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
    scrollTopRef.current = el.scrollTop
    return () => {
      // Read pinned at unmount time (not effect-creation time) so toggling
      // pin on a mounted tab does not re-save/clear the registry.
      if (pinnedRef.current) {
        setViewerState(stateKey, {
          kind: 'csv',
          scrollTop: scrollTopRef.current,
          view: viewRef.current,
        })
      } else {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey, text])

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
            {truncated ? ' (first 5 MB of file)' : ''}
          </span>
        )}
      </div>
      <div
        className="neo-csv-stage"
        ref={scrollRef}
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop
        }}
      >
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
