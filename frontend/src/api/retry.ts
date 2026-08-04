import { waitForAgentOnline } from '../state/agentReconnect';

export type RetryableErrorShape = {
  error?: string;
  message?: string;
  status?: number;
  retryable?: boolean;
  name?: string;
};

const TRANSIENT_ERROR_CODES = new Set([
  'backend_offline',
  'request_timeout',
  'hub_overloaded',
  'agent_overloaded',
  'agent_internal_error',
  'request_stalled',
]);

export function extractErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as RetryableErrorShape;
  const raw = value.error ?? '';
  if (!raw) return '';
  return raw.includes(':') ? raw.split(':')[0]! : raw;
}

export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof TypeError) return true;
  const value = error as RetryableErrorShape;
  if (value.name === 'AbortError') return false;
  if (value.retryable === true) return true;
  if (value.retryable === false) return false;
  const code = extractErrorCode(error);
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  if (value.status && [502, 503, 504].includes(value.status) && !code) return true;
  return false;
}

export function throwIfAgentError<T extends { error?: string; retryable?: boolean; message?: string }>(
  data: T,
): T {
  if (!data.error) return data;
  throw {
    error: data.error,
    message: data.message,
    retryable: data.retryable ?? isRetryableError({ error: data.error }),
  };
}

export function retryDelayMs(attempt: number, baseMs = 500, capMs = 4_000): number {
  const ceiling = Math.min(capMs, baseMs * (2 ** attempt));
  return Math.floor(Math.random() * Math.max(1, ceiling));
}

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitBeforeRetry(
  error: unknown,
  attempt: number,
  agentId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const code = extractErrorCode(error);
  if (code === 'backend_offline' && agentId) {
    const waitBudget = Math.min(30_000, 5_000 * (attempt + 1));
    try {
      await waitForAgentOnline(agentId, signal, waitBudget);
      return;
    } catch (waitError) {
      if (waitError instanceof DOMException && waitError.name === 'AbortError') {
        throw waitError;
      }
    }
  }
  await sleepMs(retryDelayMs(attempt), signal);
}

export async function retryAsync<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  opts: {
    maxAttempts: number;
    agentId?: string;
    signal?: AbortSignal;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
  },
): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? isRetryableError;
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const attemptController = new AbortController();
    const onParentAbort = () => attemptController.abort();
    opts.signal?.addEventListener('abort', onParentAbort);
    try {
      return await fn(attempt, attemptController.signal);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      const hasAttemptsLeft = attempt + 1 < opts.maxAttempts;
      if (!hasAttemptsLeft || !shouldRetry(error, attempt)) {
        throw error;
      }
      opts.onRetry?.(error, attempt);
      await waitBeforeRetry(error, attempt, opts.agentId, opts.signal);
    } finally {
      opts.signal?.removeEventListener('abort', onParentAbort);
    }
  }
  throw lastError;
}

export async function parseHttpErrorBody(res: Response): Promise<RetryableErrorShape> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return { status: res.status, message: `HTTP ${res.status}` };
  }
  try {
    const body = await res.json() as RetryableErrorShape;
    return { status: res.status, ...body };
  } catch {
    return { status: res.status, message: `HTTP ${res.status}` };
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number; agentId?: string; onRetry?: (attempt: number) => void } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 2;
  return retryAsync(async (_attempt, attemptSignal) => {
    const res = await fetch(url, { ...init, signal: attemptSignal });
    if (!res.ok) {
      const body = await parseHttpErrorBody(res);
      throw body;
    }
    return res;
  }, {
    maxAttempts,
    agentId: opts.agentId,
    signal: init.signal ?? undefined,
    onRetry: (_error, attempt) => opts.onRetry?.(attempt + 1),
  });
}
