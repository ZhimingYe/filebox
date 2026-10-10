import { useEffect, useState } from 'react'
import { fetchFileRawBlobUrl } from '../api/hub'

type Props = {
  agentId: string
  root: string
  path: string
  active: boolean
}

/**
 * Minimal PDF body for neo spike.
 * Hub `/api/file/raw` is not iframe-safe (X-Frame-Options: DENY), and
 * `/api/preview/sessions` only accepts HTML/ipynb — so we fetch with CSRF
 * into a blob: URL and keep the iframe mounted across park/restore.
 */
export function PdfFrame({ agentId, root, path, active }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    void (async () => {
      try {
        objectUrl = await fetchFileRawBlobUrl(agentId, root, path, ac.signal)
        if (!ac.signal.aborted) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch (e) {
        if (ac.signal.aborted) return
        const msg =
          e && typeof e === 'object' && 'error' in e
            ? String((e as { error?: string }).error)
            : e && typeof e === 'object' && 'message' in e
              ? String((e as { message?: string }).message)
              : 'preview_failed'
        setError(msg)
      }
    })()
    return () => {
      ac.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
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
