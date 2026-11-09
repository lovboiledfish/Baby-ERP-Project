/** Error returned by the Steward API ({ error: { message, detail } }). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

/** Fired on any 401 so the shell can show the login page. */
export const UNAUTHORIZED_EVENT = 'steward:unauthorized';

export function withQuery(path: string, query: ApiOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Same-origin JSON fetch. Authentication is the HttpOnly session cookie set by
 * login; the X-Steward-CSRF header proves the request came from this app.
 */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Steward-CSRF': '1', ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(withQuery(path, opts.query), { method: opts.method ?? 'GET', headers, body, credentials: 'same-origin' });
  const text = res.status === 204 ? '' : await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string; detail?: string | null } } | undefined)?.error;
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(err?.message ?? `Request failed (${res.status})`, res.status, err?.detail ?? null);
  }
  const data = json && typeof json === 'object' && 'result' in json ? (json as { result: T }).result : (json as T);
  return { data, headers: res.headers, status: res.status };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.detail ? `${e.message}: ${e.detail}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
