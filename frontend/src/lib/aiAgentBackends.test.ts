import { expect, it } from 'vitest';
import type { AiAgentsCapability } from '../api/client';
import { aiAgentBackend, aiAgentBackendLabel, aiAgentFeatures } from './aiAgentBackends';

it.each(['toString', '__proto__', 'constructor'])('uses the generic backend for inherited key %j', kind => {
  expect(aiAgentBackend(kind)).toBe(aiAgentBackend('unknown'));
  expect(aiAgentBackendLabel(kind)).toBe('AI agent backend');
});

it.each([null, undefined, '', 'unknown'])('uses generic backend for %j', kind => {
  expect(aiAgentBackend(kind).kind).toBe('generic');
  expect(aiAgentBackendLabel(kind, '1.2')).toBe('AI agent backend 1.2');
});
it('labels detected backends and applies version-specific warnings', () => {
  expect(aiAgentBackendLabel('herdr')).toBe('Herdr');
  expect(aiAgentBackendLabel('herdr', '0.9.5')).toBe('Herdr 0.9.5');
  expect(aiAgentBackend('herdr').versionNote?.('0.9.5')).toContain('lacks');
  expect(aiAgentBackend('herdr').versionNote?.('0.9.6')).toBeNull();
});
it('selects features only from the selected backend, preserving explicit false and copying defaults', () => {
  const capability = { backend: 'hc', backends: [
    { kind: 'herdr', features: { prompt_wait: true } },
    { kind: 'hc', features: { prompt_wait: false, keys: ['Enter'] } },
  ] } as AiAgentsCapability;
  const before = structuredClone(capability);
  expect(aiAgentFeatures(capability)).toEqual({ prompt_wait: false, read_visible: true, read_ansi: false, status_detection: true, keys: ['Enter'] });
  expect(capability).toEqual(before);
  const defaults = aiAgentFeatures();
  defaults.prompt_wait = false;
  expect(aiAgentFeatures(null).prompt_wait).toBe(true);
  expect(aiAgentFeatures({ ...capability, backend: 'missing' })).toEqual(aiAgentFeatures());
});
