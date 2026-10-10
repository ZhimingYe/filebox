import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchFileRawText } from '../api/hub'
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
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stateKey = viewerStateKey(tabId, 0)

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
    const saved = getViewerState(stateKey)
    if (saved?.kind === 'scroll') {
      el.scrollTop = saved.scrollTop
      if (saved.scrollLeft != null) el.scrollLeft = saved.scrollLeft
    }
    return () => {
      if (pinned) {
        setViewerState(stateKey, {
          kind: 'scroll',
          scrollTop: el.scrollTop,
          scrollLeft: el.scrollLeft,
        })
      } else {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey, text, pinned])

  if (error) return <p className="neo-panel__muted">Markdown failed: {error}</p>
  if (text == null) return <p className="neo-panel__muted">Loading markdown…</p>

  return (
    <div className="neo-md-frame" ref={scrollRef}>
      <article className="neo-md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </article>
    </div>
  )
}
