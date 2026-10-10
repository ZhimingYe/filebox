import { lazy, Suspense, useEffect, useState } from 'react'
import { fetchFileRawText } from '../api/hub'
import { viewerStateKey } from './previewKeepAlive'
import { CODE_PREVIEW_MAX_BYTES, langForExt, previewExt } from './codeLang'
import { formatBytes, trimToLastLine } from './textPreview'

const CodeEditor = lazy(() => import('./CodeEditor'))

type Props = {
  agentId: string
  root: string
  path: string
  tabId: string
  pinned: boolean
}

export function CodeFrame({ agentId, root, path, tabId, pinned }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [totalBytes, setTotalBytes] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateKey = viewerStateKey(tabId, 0)

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
          CODE_PREVIEW_MAX_BYTES,
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

  if (error) return <p className="neo-panel__muted">Code failed: {error}</p>
  if (text == null) return <p className="neo-panel__muted">Loading file…</p>

  return (
    <div className="neo-code-host">
      {truncated && (
        <p className="neo-panel__muted neo-code-banner">
          Large file: showing only the first {formatBytes(CODE_PREVIEW_MAX_BYTES)}
          {totalBytes != null ? ` of ${formatBytes(totalBytes)}` : ''}.
        </p>
      )}
      <div className="neo-code-editor">
        <Suspense fallback={<p className="neo-panel__muted">Loading editor…</p>}>
          <CodeEditor
            text={text}
            lang={langForExt(previewExt(path))}
            stateKey={stateKey}
            pinned={pinned}
          />
        </Suspense>
      </div>
    </div>
  )
}
