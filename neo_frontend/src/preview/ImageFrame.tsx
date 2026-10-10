import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFileRawBlobUrl } from '../api/hub'
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
  /** Tab id for registry restore (#86 state strategy). */
  tabId: string
  pinned: boolean
  active: boolean
}

const ZOOM_MIN = 0.1
const ZOOM_MAX = 5
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
])

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase())
}

/**
 * Image preview with zoom/pan. Unmounts when inactive (#86 `state`);
 * restores from ViewerStateRegistry on remount.
 */
export function ImageFrame({ agentId, root, path, tabId, pinned, active }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateKey = viewerStateKey(tabId, 0)
  const saved = getViewerState(stateKey)
  const initial =
    saved && saved.kind === 'image'
      ? saved
      : { zoom: 1, rotation: 0, pos: { x: 0, y: 0 } }

  const [zoom, setZoom] = useState(initial.zoom)
  const [rotation, setRotation] = useState(initial.rotation)
  const [pos, setPos] = useState(initial.pos)
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

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
            : 'preview_failed'
        setError(msg)
      }
    })()
    return () => {
      ac.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [agentId, root, path])

  // Pin = keep state: only persist when pinned; otherwise drop registry key.
  useEffect(() => {
    return () => {
      if (pinned) {
        setViewerState(stateKey, {
          kind: 'image',
          zoom,
          rotation,
          pos,
        })
      } else {
        clearViewerState(stateKey)
      }
    }
  }, [stateKey, zoom, rotation, pos, pinned])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + delta)))
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      dragRef.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }
    },
    [pos],
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPos({
      x: d.px + (e.clientX - d.x),
      y: d.py + (e.clientY - d.y),
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  if (error) {
    return <p className="neo-panel__muted">Image failed: {error}</p>
  }
  if (!url) {
    return <p className="neo-panel__muted">Loading image…</p>
  }

  return (
    <div className="neo-image-host">
      <div className="neo-image-toolbar">
        <button type="button" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + 0.1))}>
          +
        </button>
        <button type="button" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - 0.1))}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1)
            setPos({ x: 0, y: 0 })
            setRotation(0)
          }}
        >
          Reset
        </button>
        <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)}>
          Rotate
        </button>
        <span className="neo-image-zoom">{Math.round(zoom * 100)}%</span>
      </div>
      <div
        className="neo-image-stage"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={url}
          alt={path}
          draggable={false}
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) rotate(${rotation}deg) scale(${zoom})`,
            transformOrigin: 'center center',
            maxWidth: '100%',
            maxHeight: '100%',
            pointerEvents: active ? 'auto' : 'none',
            userSelect: 'none',
          }}
        />
      </div>
    </div>
  )
}
