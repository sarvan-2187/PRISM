/**
 * Client for the demo-only session-reveal endpoint (/api/v1/demo/my-session).
 * Separate from api-client.ts and attackApi.ts on purpose: this talks to a
 * standalone backend module (backend/src/modules/attacks/demoSessionReveal.ts)
 * that is hard-disabled outside development and requires ATTACK_LAB_DEMO_ENABLED
 * — it is never assumed to exist, always probed first (mirrors the
 * `cardsEnabled()` pattern in api-client.ts).
 */
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export async function demoSessionRevealEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/v1/demo/enabled`, { credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns this browser's own real session cookie header, or null if not signed in / not enabled. */
export async function revealMySession(): Promise<string | null> {
  const res = await fetch(`${API_URL}/api/v1/demo/my-session`, { credentials: 'include' });
  if (!res.ok) return null;
  const body = await res.json();
  return body.cookieHeader ?? null;
}
