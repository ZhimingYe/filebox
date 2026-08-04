import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractErrorCode,
  isRetryableError,
  retryDelayMs,
  throwIfAgentError,
} from './retry';

describe('isRetryableError', () => {
  it('treats explicit retryable metadata as authoritative', () => {
    expect(isRetryableError({ retryable: true, error: 'not_found' })).toBe(true);
    expect(isRetryableError({ retryable: false, error: 'backend_offline' })).toBe(false);
  });

  it('classifies transient transport and agent errors', () => {
    expect(isRetryableError({ error: 'backend_offline' })).toBe(true);
    expect(isRetryableError({ error: 'request_timeout' })).toBe(true);
    expect(isRetryableError({ error: 'agent_overloaded: queue full' })).toBe(true);
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('rejects permanent access failures', () => {
    expect(isRetryableError({ error: 'path_denied' })).toBe(false);
    expect(isRetryableError({ error: 'not_found' })).toBe(false);
    expect(isRetryableError({ name: 'AbortError' })).toBe(false);
  });
});

describe('extractErrorCode', () => {
  it('strips agent error suffixes', () => {
    expect(extractErrorCode({ error: 'agent_busy: another search is running' })).toBe('agent_busy');
  });
});

describe('throwIfAgentError', () => {
  it('passes through successful agent payloads', () => {
    expect(throwIfAgentError({
      items: [],
      next_cursor: null,
    } as { items: unknown[]; next_cursor: string | null; error?: string })).toEqual({
      items: [],
      next_cursor: null,
    });
  });

  it('throws structured retryable errors from 200 responses', () => {
    try {
      throwIfAgentError({
        error: 'backend_offline',
        retryable: true,
      });
      expect.unreachable('expected throwIfAgentError to throw');
    } catch (error) {
      expect(error).toMatchObject({ error: 'backend_offline', retryable: true });
    }
  });
});

describe('retryDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays within the configured cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(retryDelayMs(0, 500, 4000)).toBeLessThanOrEqual(4000);
    expect(retryDelayMs(3, 500, 4000)).toBeLessThanOrEqual(4000);
  });
});
