import { useEffect, useState } from 'react'
import { createPreviewSession } from '../api/hub'

type Props = {
  agentId: string
  root: string
  path: string
  active: boolean
}

const HTML_SANDBOX = 'allow-scripts allow-downloads'

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Outer blob page + inner tokenized document URL (classic HtmlPreview shape). */
function makeSandboxWrapper(documentUrl: string): string {
  const origin = new URL(documentUrl, window.location.origin).origin
  const safeUrl = escapeHtmlAttr(documentUrl)
  const safeOrigin = escapeHtmlAttr(origin)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src ${safeOrigin};">
<title>HTML Preview</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#0b0c10;}
iframe{border:0;width:100%;height:100%;}
</style>
</head>
<body>
<iframe sandbox="${HTML_SANDBOX}" src="${safeUrl}" title="HTML Preview"></iframe>
</body>
</html>`
}

/**
 * HTML / ipynb via Hub preview session. Stays mounted under #86 dom-park
 * so the iframe session survives Pin tab switches.
 */
export function HtmlFrame({ agentId, root, path, active }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    void (async () => {
      try {
        const session = await createPreviewSession(agentId, root, path, ac.signal)
        const wrapper = makeSandboxWrapper(session.document_url)
        objectUrl = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' }))
        if (!ac.signal.aborted) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch (e) {
        if (ac.signal.aborted) return
        const msg =
          e && typeof e === 'object' && 'error' in e
            ? String((e as { error?: string }).error)
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
    return <p className="neo-panel__muted">HTML preview failed: {error}</p>
  }
  if (!url) {
    return <p className="neo-panel__muted">Loading HTML…</p>
  }

  return (
    <iframe
      title={path}
      src={url}
      className="neo-pdf-frame"
      tabIndex={active ? 0 : -1}
    />
  )
}
