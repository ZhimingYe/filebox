import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type OpenTarget = {
  agentId: string
  root: string
  path: string
}

type OpenHandler = (target: OpenTarget) => void

type WorkspaceApi = {
  focusPanel: (panelId: string) => void
  registerOpenHandler: (panelId: string, handler: OpenHandler) => () => void
  openFile: (target: OpenTarget) => void
  focusedPanelId: string | null
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null)
  const handlersRef = useRef(new Map<string, OpenHandler>())
  const focusedRef = useRef<string | null>(null)

  const focusPanel = useCallback((panelId: string) => {
    focusedRef.current = panelId
    setFocusedPanelId(panelId)
  }, [])

  const registerOpenHandler = useCallback((panelId: string, handler: OpenHandler) => {
    handlersRef.current.set(panelId, handler)
    if (!focusedRef.current) {
      focusedRef.current = panelId
      setFocusedPanelId(panelId)
    }
    return () => {
      handlersRef.current.delete(panelId)
      if (focusedRef.current === panelId) {
        const next = handlersRef.current.keys().next().value ?? null
        focusedRef.current = next
        setFocusedPanelId(next)
      }
    }
  }, [])

  const openFile = useCallback((target: OpenTarget) => {
    const id = focusedRef.current
    const handler = id ? handlersRef.current.get(id) : undefined
    if (handler) {
      handler(target)
      return
    }
    const first = handlersRef.current.values().next().value
    first?.(target)
  }, [])

  const api = useMemo(
    () => ({ focusPanel, registerOpenHandler, openFile, focusedPanelId }),
    [focusPanel, registerOpenHandler, openFile, focusedPanelId],
  )

  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace requires WorkspaceProvider')
  return ctx
}
