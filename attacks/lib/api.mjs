/**
 * Minimal HTTP client for the PRISM backend, deliberately independent of
 * frontend/src/lib/api-client.ts — the attack suite must exercise the raw
 * API the way a real attacker (curl/Burp) would, not go through the app's
 * own trusted client.
 *
 * Targets localhost only. BACKEND_URL can override the port/host for local
 * testing, but this is never pointed at a remote host.
 */

const BACKEND_URL = process.env.PRISM_BACKEND_URL ?? 'http://localhost:4000';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BACKEND_URL)) {
  throw new Error(
    `Refusing to target non-local backend URL: ${BACKEND_URL}. ` +
      `Attack scripts are scoped to localhost only (see PLAN.md §10, Rules §2.D).`
  );
}

export { BACKEND_URL };

/**
 * @param {string} path e.g. '/api/v1/payment/initiate'
 * @param {object} opts
 * @param {string} [opts.method]
 * @param {object} [opts.body]
 * @param {string} [opts.cookie] raw Cookie header value, e.g. "prism_session=..."
 * @param {object} [opts.headers] extra headers, e.g. spoofed X-Forwarded-For
 */
export async function call(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie') ?? null;
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (e.g. 429 from express-rate-limit's default handler)
  }

  return { status: res.status, ok: res.ok, body: json, setCookie };
}

export const get = (path, opts) => call(path, { ...opts, method: 'GET' });
export const post = (path, body, opts) => call(path, { ...opts, method: 'POST', body });
