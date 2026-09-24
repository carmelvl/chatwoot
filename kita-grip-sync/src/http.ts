/** HTTP error that knows whether a retry can help (network, 408, 425, 429, 5xx) or not (other 4xx). */
export class HttpError extends Error {
  status: number;
  retryable: boolean;
  constructor(what: string, status: number) {
    super(`${what} -> ${status}`);
    this.status = status;
    this.retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export const isRetryable = (e: unknown) => !(e instanceof HttpError) || e.retryable;

/** fetch + JSON with a timeout; network failures surface as retryable HttpError(status 0). */
export async function requestJson(fetchImpl: typeof fetch, what: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  } catch (e: any) {
    const err = new HttpError(`${what} (${e?.name ?? 'network'})`, 0);
    throw err;
  }
  if (!res.ok) throw new HttpError(what, res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Exponential backoff with jitter: 5s, 10s, 20s ... capped at 1h. */
export function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}
