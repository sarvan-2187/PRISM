/**
 * Minimal HTTP client the attack engine uses to hit the REAL running PRISM
 * API — the same convention as attacks/lib/api.mjs, ported to TypeScript so
 * the backend-hosted engine can reuse it directly instead of shelling out to
 * the standalone script suite.
 *
 * This deliberately calls the API over the network (not the route handlers
 * directly) so every attack genuinely exercises the same HTTP surface a real
 * attacker device would — auth, rate limiting, JSON parsing, all of it.
 *
 * Scoped to localhost/127.0.0.1 only, same as the attacks/ suite — this is a
 * demo tool, not something to point at a real deployment.
 */
const BACKEND_URL = process.env.PRISM_ATTACK_TARGET_URL ?? `http://localhost:${process.env.PORT || 4000}`;

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BACKEND_URL)) {
  throw new Error(
    `Refusing to target non-local backend URL: ${BACKEND_URL}. The attack engine is scoped to localhost only.`
  );
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  setCookie: string | null;
}

export async function call(path: string, opts: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'prism-attack-simulator/1.0',
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) headers.Cookie = opts.cookie;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body
  }

  return { status: res.status, ok: res.ok, body, setCookie };
}

export const get = (path: string, opts?: CallOptions): Promise<CallResult> =>
  call(path, { ...opts, method: 'GET' });
export const post = (path: string, body?: unknown, opts?: CallOptions): Promise<CallResult> =>
  call(path, { ...opts, method: 'POST', body });

/** Pull the `prism_session=...` cookie pair out of a Set-Cookie header. */
export function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /prism_session=[^;]+/.exec(setCookie);
  return m ? m[0] : null;
}
