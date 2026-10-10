import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  keepAliveParkStyle,
  keepAliveStrategyForPath,
  MAX_DOM_PARKED,
  selectDomParkTabIds,
} from './previewKeepAlive'
import { PdfFrame } from './PdfFrame'
import { HtmlFrame } from './HtmlFrame'
import { ImageFrame, isImageExt } from './ImageFrame'
import { MarkdownFrame, isMarkdownExt } from './MarkdownFrame'
import { CsvFrame, isCsvExt } from './CsvFrame'
import type { OpenTarget } from '../state/workspace'
import { useWorkspace } from '../state/workspace'

type Tab = OpenTarget & {
  id: string
  pinned: boolean
}

function tabIdFor(target: OpenTarget): string {
  return `${target.agentId}:${target.root}:${target.path}`
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || path || '/'
}

type Props = {
  panelId: string
}

export function NeoPreviewHost({ panelId }: Props) {
  const { registerOpenHandler, focusPanel } = useWorkspace()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [activationOrder, setActivationOrder] = useState<string[]>([])

  const activate = useCallback((id: string) => {
    setActiveTabId(id)
    setActivationOrder((prev) => {
      const next = prev.filter((x) => x !== id)
      next.push(id)
      return next
    })
  }, [])

  const openTarget = useCallback(
    (target: OpenTarget) => {
      const id = tabIdFor(target)
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev
        return [...prev, { ...target, id, pinned: false }]
      })
      activate(id)
      focusPanel(panelId)
    },
    [activate, focusPanel, panelId],
  )

  useEffect(() => registerOpenHandler(panelId, openTarget), [panelId, openTarget, registerOpenHandler])

  const togglePin = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
    )
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id)
        if (activeTabId === id) {
          const fallback = next[next.length - 1]?.id ?? null
          setActiveTabId(fallback)
        }
        return next
      })
      setActivationOrder((prev) => prev.filter((x) => x !== id))
    },
    [activeTabId],
  )

  const parkedIds = useMemo(
    () =>
      new Set(
        selectDomParkTabIds(
          tabs.map((t) => ({ id: t.id, path: t.path, pinned: t.pinned })),
          activeTabId,
          activationOrder,
        ),
      ),
    [tabs, activeTabId, activationOrder],
  )

  const mountedTabs = useMemo(() => {
    return tabs.filter((t) => t.id === activeTabId || parkedIds.has(t.id))
  }, [tabs, activeTabId, parkedIds])

  return (
    <div
      className="neo-preview-host"
      onMouseDown={() => focusPanel(panelId)}
    >
      <div className="neo-tabs">
        {tabs.length === 0 && (
          <span className="neo-tabs__empty">Open a file from the tree</span>
        )}
        {tabs.map((t) => (
          <div
            key={t.id}
            className={
              t.id === activeTabId ? 'neo-tab neo-tab--active' : 'neo-tab'
            }
          >
            <button
              type="button"
              className="neo-tab__title"
              onClick={() => activate(t.id)}
              title={t.path}
            >
              {t.pinned ? '[pin] ' : ''}
              {basename(t.path)}
            </button>
            <button
              type="button"
              className="neo-tab__pin"
              title={t.pinned ? 'Unpin' : 'Pin (keep state)'}
              onClick={() => togglePin(t.id)}
            >
              {t.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              className="neo-tab__close"
              title="Close"
              onClick={() => closeTab(t.id)}
            >
              x
            </button>
          </div>
        ))}
      </div>
      <div className="neo-preview-stage">
        {mountedTabs.length === 0 && (
          <p className="neo-panel__muted">No active preview.</p>
        )}
        {mountedTabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={isActive ? 'neo-preview-active' : undefined}
              style={isActive ? undefined : keepAliveParkStyle}
              {...(isActive
                ? {}
                : ({ inert: true, 'aria-hidden': true } as Record<string, unknown>))}
            >
              <PreviewBody tab={tab} active={isActive} />
            </div>
          )
        })}
      </div>
      <footer className="neo-preview-meta">
        park ≤ {MAX_DOM_PARKED} · parked now {parkedIds.size}
        {activeTabId && tabs.find((t) => t.id === activeTabId)
          ? ` · active=${keepAliveStrategyForPath(tabs.find((t) => t.id === activeTabId)!.path)}`
          : ''}
      </footer>
    </div>
  )
}

function PreviewBody({ tab, active }: { tab: Tab; active: boolean }) {
  const ext = tab.path.split('.').pop()?.toLowerCase() || ''
  if (ext === 'pdf') {
    return (
      <PdfFrame
        agentId={tab.agentId}
        root={tab.root}
        path={tab.path}
        active={active}
      />
    )
  }
  if (ext === 'html' || ext === 'htm' || ext === 'ipynb') {
    return (
      <HtmlFrame
        agentId={tab.agentId}
        root={tab.root}
        path={tab.path}
        active={active}
      />
    )
  }
  if (isImageExt(ext)) {
    return (
      <ImageFrame
        agentId={tab.agentId}
        root={tab.root}
        path={tab.path}
        tabId={tab.id}
        pinned={tab.pinned}
        active={active}
      />
    )
  }
  if (isMarkdownExt(ext)) {
    return (
      <MarkdownFrame
        agentId={tab.agentId}
        root={tab.root}
        path={tab.path}
        tabId={tab.id}
        pinned={tab.pinned}
      />
    )
  }
  if (isCsvExt(ext)) {
    return (
      <CsvFrame
        agentId={tab.agentId}
        root={tab.root}
        path={tab.path}
        tabId={tab.id}
        pinned={tab.pinned}
        ext={ext}
      />
    )
  }
  return (
    <div className="neo-panel__body">
      <p className="neo-panel__muted">
        {basename(tab.path)} — PDF/HTML/ipynb/images/md/csv supported; Monaco later.
      </p>
    </div>
  )
}
