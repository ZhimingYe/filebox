import type { AiAgentFeatures, AiAgentsCapability } from '../api/client';

export interface AiAgentBackendDescriptor {
  kind: string;
  label: string;
  installUrl?: string;
  installGuide: string;
  binaryName?: string;
  binaryEnvironment?: string;
  serverCommand?: string;
  versionNote?: (version: string | null | undefined) => string | null;
  unsupportedKeyNote?: string;
  noServerMessage?: string;
  noAgentsMessage?: string;
}

const herdr: AiAgentBackendDescriptor = {
  kind: 'herdr',
  label: 'Herdr',
  installUrl: 'https://herdr.ink/',
  installGuide: 'Herdr installation guide',
  binaryName: 'herdr',
  binaryEnvironment: 'FILEBOX_AGENT_HERDR',
  serverCommand: 'herdr server',
  versionNote: (version) => version === '0.9.5'
    ? 'Herdr 0.9.5 lacks Home, End, PageUp, PageDown, and Delete key support.'
    : null,
  unsupportedKeyNote: 'Herdr v0.9.5 lacks Home, End, PageUp, PageDown and Delete; use a server build with navigation-key support.',
  noServerMessage: 'Start Herdr on this backend with herdr or herdr server, then refresh. Filebox only talks to the local CLI — never to agents on other machines.',
  noAgentsMessage: 'Start a coding agent inside Herdr on this machine. Filebox will list it here so you can read output and send a prompt from your phone.',
};

const hc: AiAgentBackendDescriptor = {
  kind: 'hc',
  label: 'hc (experimental)',
  installUrl: 'https://github.com/herdrdev/herdr-core#install',
  installGuide: 'herdr-core installation guide',
  binaryName: 'hc',
  binaryEnvironment: 'FILEBOX_AGENT_HC',
  serverCommand: 'hc run --bg --name frontend -- claude',
  versionNote: () => 'Experimental hc generation-1 API. Local live coding-agent terminals reporting OSC 7501 status.app are included automatically, using hc terminal names.',
  noServerMessage: 'Check hc on the Agent machine. Filebox uses hc connect, which can start the local core automatically; the API must support generation 1.',
  noAgentsMessage: 'Start with hc run --bg --name frontend -- claude. Local live terminals appear automatically when the coding agent reports a non-empty status.app via OSC 7501. Plain shells without status are not listed.',
};

export const aiAgentBackends: Record<string, AiAgentBackendDescriptor> = {
  herdr,
  hc,
};

export const supportedAiAgentBackends = Object.values(aiAgentBackends);

const fallback: AiAgentBackendDescriptor = {
  kind: 'generic',
  label: 'AI agent backend',
  installGuide: 'backend installation guide',
  noServerMessage: 'Start the AI agent backend on this machine, then refresh.',
  noAgentsMessage: 'Start a coding agent on this machine. Filebox will list it here so you can read output and send a prompt.',
};

export function aiAgentBackend(kind?: string | null): AiAgentBackendDescriptor {
  return kind && Object.hasOwn(aiAgentBackends, kind) ? aiAgentBackends[kind] : fallback;
}

const defaultFeatures: AiAgentFeatures = {
  prompt_wait: true,
  read_visible: true,
  keys: null,
  status_detection: true,
};

export function aiAgentFeatures(capability?: AiAgentsCapability | null): AiAgentFeatures {
  const features = capability?.backends?.find((backend) => backend.kind === capability.backend)?.features;
  return features ? { ...defaultFeatures, ...features } : { ...defaultFeatures };
}

export function aiAgentBackendLabel(kind?: string | null, version?: string | null): string {
  const backend = aiAgentBackend(kind);
  return version ? `${backend.label} ${version}` : backend.label;
}
