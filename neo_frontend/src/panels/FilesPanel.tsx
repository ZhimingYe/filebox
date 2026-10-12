/**
 * Neo Files dock panel — mounts classic FileBrowser (DirectoryTree + list)
 * against the hub with the same session/CSRF client as classic.
 *
 * Desktop-only for this spike (no mobile drawer layout). Preview open is
 * emitted via `emitNeoOpenFile` for 开发助手2 to wire.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { AgentInfo, FsEntry } from '@classic/api/client';
import { FileBrowser } from '@classic/components/FileBrowser';
import {
  LAST_AGENT_STORAGE,
  loadNavPosMap,
  loadPathMemoryMap,
  memKey,
  persistNavState,
} from '@classic/state/navPersistence';
import { useHealth } from '@classic/state/health';
import { c, font } from '../theme';
import {
  emitNeoAgentSelected,
  emitNeoOpenFile,
  onNeoRevealInBrowser,
} from '../events/openFile';

export function FilesPanel(_props: IDockviewPanelProps) {
  const { agents, error: healthError, refresh } = useHealth(true);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_AGENT_STORAGE);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (selectedAgentId) localStorage.setItem(LAST_AGENT_STORAGE, selectedAgentId);
      else localStorage.removeItem(LAST_AGENT_STORAGE);
    } catch {
      /* ignore */
    }
  }, [selectedAgentId]);



  useEffect(() => {
    if (!selectedAgentId || agents.length === 0) return;
    if (!agents.some((a) => a.id === selectedAgentId)) setSelectedAgentId(null);
  }, [agents, selectedAgentId]);

  // Prefer restored agent; otherwise first online/slow, else first listed.
  useEffect(() => {
    if (selectedAgentId || agents.length === 0) return;
    const preferred =
      agents.find((a) => a.status === 'online' || a.status === 'slow') ?? agents[0];
    setSelectedAgentId(preferred.id);
  }, [agents, selectedAgentId]);

  const selectedAgent: AgentInfo | null = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  // Preview context + foreign-tab cleanup (classic: previews never outlive agent).
  useEffect(() => {
    emitNeoAgentSelected({
      agentId: selectedAgentId,
      roots: selectedAgent?.roots,
      officeCapable: !!selectedAgent?.capabilities?.office_pdf_preview,
    });
  }, [selectedAgentId, selectedAgent]);

  const [filePosSeed] = useState(loadNavPosMap);
  const [pathMemSeed] = useState(loadPathMemoryMap);
  const filePosByAgent = useRef(filePosSeed);
  const pathMemory = useRef(pathMemSeed);

  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');

  const enabledRoots = useMemo(
    () => (selectedAgent ? selectedAgent.roots.filter((r) => r.enabled) : []),
    [selectedAgent],
  );

  const prevAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgent) {
      setSelectedRoot(null);
      setCurrentPath('/');
      prevAgentIdRef.current = null;
      return;
    }
    const agentId = selectedAgent.id;
    const agentChanged = prevAgentIdRef.current !== agentId;

    if (enabledRoots.length === 0) {
      setSelectedRoot(null);
      prevAgentIdRef.current = agentId;
      return;
    }

    if (agentChanged) {
      prevAgentIdRef.current = agentId;
      const saved = filePosByAgent.current.get(agentId);
      const root =
        saved && enabledRoots.some((r) => r.name === saved.root)
          ? saved.root
          : enabledRoots[0].name;
      const path =
        saved && saved.root === root
          ? saved.path
          : pathMemory.current.get(memKey(agentId, root)) || '/';
      setSelectedRoot(root);
      setCurrentPath(path);
      return;
    }

    const rootValid = selectedRoot && enabledRoots.some((r) => r.name === selectedRoot);
    if (!rootValid) {
      const fallback = enabledRoots[0].name;
      setSelectedRoot(fallback);
      setCurrentPath(pathMemory.current.get(memKey(agentId, fallback)) || '/');
    }
  }, [selectedAgent, enabledRoots, selectedRoot]);

  const applyNav = useCallback(
    (root: string, path: string) => {
      setSelectedRoot(root);
      setCurrentPath(path);
      if (selectedAgent) {
        filePosByAgent.current.set(selectedAgent.id, { root, path });
        pathMemory.current.set(memKey(selectedAgent.id, root), path);
        persistNavState(filePosByAgent.current, pathMemory.current);
      }
    },
    [selectedAgent],
  );

  useEffect(() => {
    return onNeoRevealInBrowser(({ root, dirPath }) => {
      if (!selectedAgent) return;
      applyNav(root, dirPath);
    });
  }, [selectedAgent, applyNav]);

  const switchRoot = useCallback(
    (root: string) => {
      if (!selectedAgent) return;
      if (selectedRoot) {
        pathMemory.current.set(memKey(selectedAgent.id, selectedRoot), currentPath);
      }
      const restored = pathMemory.current.get(memKey(selectedAgent.id, root)) || '/';
      applyNav(root, restored);
    },
    [selectedAgent, selectedRoot, currentPath, applyNav],
  );

  const handleFileSelect = useCallback(
    (root: string, path: string, entry: FsEntry) => {
      if (!selectedAgent) return;
      emitNeoOpenFile({
        agentId: selectedAgent.id,
        root,
        path,
        entry,
        officeCapable: !!selectedAgent.capabilities?.office_pdf_preview,
        roots: selectedAgent.roots,
      });
    },
    [selectedAgent],
  );

  if (agents.length === 0) {
    return (
      <div style={shellStyle}>
        <div style={msgStyle}>
          {healthError
            ? `Could not load agents: ${healthError}`
            : 'No agents yet. Connect an agent to the hub, then refresh.'}
        </div>
        <button type="button" style={btnStyle} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
    );
  }

  if (!selectedAgent) {
    return (
      <div style={shellStyle}>
        <div style={msgStyle}>Select an agent to browse files.</div>
        <AgentSelect
          agents={agents}
          value={selectedAgentId}
          onChange={setSelectedAgentId}
        />
      </div>
    );
  }

  if (enabledRoots.length === 0) {
    return (
      <div style={shellStyle}>
        <div style={toolbarStyle}>
          <AgentSelect
            agents={agents}
            value={selectedAgentId}
            onChange={setSelectedAgentId}
          />
        </div>
        <div style={msgStyle}>
          Agent <strong>{selectedAgent.name || selectedAgent.id}</strong> has no
          enabled roots.
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...shellStyle, padding: 0, gap: 0 }}>
      <div style={toolbarStyle}>
        <AgentSelect
          agents={agents}
          value={selectedAgentId}
          onChange={setSelectedAgentId}
        />
        <span style={{ color: c.textMuted, fontSize: 11, fontFamily: font.mono }}>
          {selectedAgent.status}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <FileBrowser
          agentId={selectedAgent.id}
          roots={selectedAgent.roots}
          onFileSelect={handleFileSelect}
          onRootsChange={refresh}
          selectedRoot={selectedRoot}
          currentPath={currentPath}
          onApplyNav={applyNav}
          onSwitchRoot={switchRoot}
        />
      </div>
    </div>
  );
}

function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: AgentInfo[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ color: c.textMuted }}>Agent</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: font.sans,
          fontSize: 12,
          padding: '2px 6px',
          border: `1px solid ${c.border}`,
          borderRadius: 6,
          background: c.surface,
          color: c.text,
          maxWidth: 220,
        }}
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name || a.id} ({a.status})
          </option>
        ))}
      </select>
    </label>
  );
}

const shellStyle: CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 8,
  background: c.bgSubtle,
  color: c.textSecondary,
  fontFamily: font.sans,
  fontSize: 13,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px',
  borderBottom: `1px solid ${c.border}`,
  background: c.surface,
  flexShrink: 0,
};

const msgStyle: CSSProperties = {
  color: c.textMuted,
  lineHeight: 1.5,
  padding: 8,
};

const btnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontFamily: font.sans,
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.surface,
  color: c.text,
  cursor: 'pointer',
};
