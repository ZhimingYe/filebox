import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchFileRawText } from '../api/hub'
import { MD_PREVIEW_MAX_BYTES, formatBytes, trimToLastLine } from './textPreview'
import {
  clearViewerState,
  getViewerState,
  setViewerState,
  viewerStateKey,
} from './previewKeepAlive'

type Props = {
  agentId: string
  root: string
  path: string
  tabId: string
  pinned: boolean
}

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownExt(ext: string): boolean {
  return MD_EXTS.has(ext.toLowerCase())
}

export function MarkdownFrame({ agentId, root, path, tabId, pinned }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [totalBytes, setTotalBytes] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stateKey = viewerStateKey(tabId, 0)
  // Passive-effect cleanup on unmount runs after the DOM node is detached
  // (scrollTop reads 0), so track the live scroll position via onScroll.
  const scrollPosRef = useRef({ top: 0, left: 0 })
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  useEffect(() => {
    const ac = new AbortController()
    setText(null)
    setError(null)
    void (async () => {
      try {
        const body = await fetchFileRawText(
          agentId,
          root,
          path,
          ac.signal,
          MD_PREVIEW_MAX_BYTES,
        )
        if (!ac.signal.aborted) {
          setText(body.truncated ? trimToLastLine(body.text) : body.text)
          setTruncated(body.truncated)
          setTotalBytes(body.totalBytes)
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
    const saved = getViewerState(stateKey)
    if (saved?.kind === 'scroll') {
      el.scrollTop = saved.scrollTop
      if (saved.scrollLeft != null) el.scrollLeft = saved.scrollLeft
    }
    scrollPosRef.current = { top: el.scrollTop, left: el.scrollLeft }
    return () => {
      // Read pinned at unmount time (not effect-creation time) so toggling
      // pin on a mounted tab does not re-save/clear the registry.
      if (pinnedRef.current) {
        setViewerState(stateKey, {
          kind: 'scroll',
          scrollTop: scrollPosRef.current.top,
          scrollLeft: scrollPosRef.current.left,
        })
      } else {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey, text])

  if (error) return <p className="neo-panel__muted">Markdown failed: {error}</p>
  if (text == null) return <p className="neo-panel__muted">Loading markdown…</p>

  return (
    <div
      className="neo-md-frame"
      ref={scrollRef}
      onScroll={(e) => {
        scrollPosRef.current = {
          top: e.currentTarget.scrollTop,
          left: e.currentTarget.scrollLeft,
        }
      }}
    >
      {truncated && (
        <p className="neo-panel__muted">
          Large file: showing only the first {formatBytes(MD_PREVIEW_MAX_BYTES)}
          {totalBytes != null ? ` of ${formatBytes(totalBytes)}` : ''} (preview
          is capped to keep the page responsive).
        </p>
      )}
      <article className="neo-md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </article>
    </div>
  )
}
