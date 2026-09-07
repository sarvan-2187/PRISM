/**
 * Real WebAuthn ceremonies, driven by a Chrome DevTools Protocol "virtual
 * authenticator" — the same mechanism the threat-model playbook names in
 * §1 ("Virtual authenticator abuse ... Chrome DevTools WebAuthn panel").
 *
 * This is NOT a shortcut around PRISM's security: the browser still runs
 * the genuine WebAuthn ceremony (real challenge, real origin/rpId binding,
 * a real Ed25519/ES256 keypair generated per credential, a real signature
 * over the exact bytes the server sent). The only thing that's virtual is
 * the biometric prompt — precisely the CI-friendly substitution Chrome
 * itself ships this feature for. Everything downstream (session cookie,
 * intent hash as challenge, signature verification) is the real code path.
 *
 * Used only by setup/provision.mjs. Every other attack script is plain
 * HTTP and does not import this file — most of PRISM's protections
 * (tamper, replay, expiry, QR, IDOR, rate limiting, session integrity) are
 * enforced BEFORE signature verification runs, so they don't need a real
 * assertion to test honestly.
 */
import { chromium } from 'playwright';

const FRONTEND_ORIGIN = process.env.PRISM_FRONTEND_URL ?? 'http://localhost:5173';
const BACKEND_URL = process.env.PRISM_BACKEND_URL ?? 'http://localhost:4000';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(FRONTEND_ORIGIN)) {
  throw new Error(`Refusing to drive a non-local frontend origin: ${FRONTEND_ORIGIN}`);
}

/** Converts between base64url (server/API wire format) and ArrayBuffer (WebAuthn API format). */
const BROWSER_HELPERS = `
  window.__b64urlToBuf = (b64url) => {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  };
  window.__bufToB64url = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
`;

export async function launch() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(FRONTEND_ORIGIN);
  await page.addScriptTag({ content: BROWSER_HELPERS });

  return {
    browser,
    context,
    page,
    async close() {
      await browser.close();
    },
  };
}

/** Registers a brand-new passkey for an existing seeded user (asha@prism.demo / priya@prism.demo). */
export async function registerPasskey(page, email) {
  const optionsRes = await page.evaluate(
    async ({ backend, email }) => {
      const r = await fetch(`${backend}/api/v1/auth/register/options`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, email }
  );
  if (optionsRes.status !== 200) {
    throw new Error(`register/options failed: ${optionsRes.status} ${JSON.stringify(optionsRes.body)}`);
  }
  const options = optionsRes.body;

  const credentialJSON = await page.evaluate(async (options) => {
    const publicKey = {
      ...options,
      challenge: window.__b64urlToBuf(options.challenge),
      user: { ...options.user, id: window.__b64urlToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: window.__b64urlToBuf(c.id),
      })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    return {
      id: cred.id,
      rawId: window.__bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: window.__bufToB64url(cred.response.attestationObject),
        clientDataJSON: window.__bufToB64url(cred.response.clientDataJSON),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }, options);

  const verifyRes = await page.evaluate(
    async ({ backend, email, response }) => {
      const r = await fetch(`${backend}/api/v1/auth/register/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, response }),
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, email, response: credentialJSON }
  );
  if (verifyRes.status !== 200) {
    throw new Error(`register/verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  }
  return verifyRes.body;
}

/** Full passkey login. Leaves the session cookie set on the Playwright browser context. */
export async function login(page, email) {
  const optionsRes = await page.evaluate(
    async ({ backend, email }) => {
      const r = await fetch(`${backend}/api/v1/auth/login/options`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, email }
  );
  if (optionsRes.status !== 200) {
    throw new Error(`login/options failed: ${optionsRes.status} ${JSON.stringify(optionsRes.body)}`);
  }
  const options = optionsRes.body;

  const assertionJSON = await page.evaluate(async (options) => {
    const publicKey = {
      ...options,
      challenge: window.__b64urlToBuf(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        ...c,
        id: window.__b64urlToBuf(c.id),
      })),
    };
    const cred = await navigator.credentials.get({ publicKey });
    return {
      id: cred.id,
      rawId: window.__bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: window.__bufToB64url(cred.response.authenticatorData),
        clientDataJSON: window.__bufToB64url(cred.response.clientDataJSON),
        signature: window.__bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? window.__bufToB64url(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }, options);

  const verifyRes = await page.evaluate(
    async ({ backend, email, response }) => {
      const r = await fetch(`${backend}/api/v1/auth/login/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, response }),
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, email, response: assertionJSON }
  );
  if (verifyRes.status !== 200) {
    throw new Error(`login/verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  }
  return verifyRes.body;
}

/**
 * Approves a locked payment with a REAL transaction-bound assertion: fetches
 * the challenge (which is the intent hash), signs it with the virtual
 * authenticator, and posts /authorize. Returns the raw HTTP result so the
 * caller (setup script) can inspect the risk decision.
 */
export async function approvePayment(page, txId, deliberationMs = 3000) {
  const challengeRes = await page.evaluate(
    async ({ backend, txId }) => {
      const r = await fetch(`${backend}/api/v1/payment/${txId}/challenge`, {
        method: 'POST',
        credentials: 'include',
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, txId }
  );
  if (challengeRes.status !== 200) {
    throw new Error(`challenge failed: ${challengeRes.status} ${JSON.stringify(challengeRes.body)}`);
  }
  const options = challengeRes.body;

  const assertionJSON = await page.evaluate(async (options) => {
    const publicKey = {
      ...options,
      challenge: window.__b64urlToBuf(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        ...c,
        id: window.__b64urlToBuf(c.id),
      })),
    };
    const cred = await navigator.credentials.get({ publicKey });
    return {
      id: cred.id,
      rawId: window.__bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: window.__bufToB64url(cred.response.authenticatorData),
        clientDataJSON: window.__bufToB64url(cred.response.clientDataJSON),
        signature: window.__bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? window.__bufToB64url(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }, options);

  const authorizeRes = await page.evaluate(
    async ({ backend, txId, assertion, deliberationMs }) => {
      const r = await fetch(`${backend}/api/v1/payment/${txId}/authorize`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assertion, deliberationMs }),
      });
      return { status: r.status, body: await r.json() };
    },
    { backend: BACKEND_URL, txId, assertion: assertionJSON, deliberationMs }
  );
  return authorizeRes;
}

/** Reads the httpOnly session cookie straight from the browser context. */
export async function sessionCookie(context) {
  const cookies = await context.cookies();
  const c = cookies.find((c) => c.name === 'prism_session');
  return c ? `prism_session=${c.value}` : null;
}
