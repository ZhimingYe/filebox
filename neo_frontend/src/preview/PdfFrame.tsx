import { useEffect, useState } from 'react'
import { createPreviewSession } from '../api/hub'

type Props = {
  agentId: string
  root: string
  path: string
  active: boolean
}

/** Minimal PDF body for neo spike — preview session iframe (same-origin). */
export function PdfFrame({ agentId, root, path, active }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    setUrl(null)
    setError(null)
    void (async () => {
      try {
        const session = await createPreviewSession(agentId, root, path, ac.signal)
        if (!ac.signal.aborted) setUrl(session.document_url)
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

  if (error) {
    return <p className="neo-panel__muted">Preview failed: {error}</p>
  }
  if (!url) {
    return <p className="neo-panel__muted">Loading PDF…</p>
  }

  return (
    <iframe
      title={path}
      src={url}
      className="neo-pdf-frame"
      // Keep parked iframes loaded; inert handled by park wrapper.
      tabIndex={active ? 0 : -1}
    />
  )
}
