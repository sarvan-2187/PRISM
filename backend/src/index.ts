import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import https from 'https';
import { config } from './config/env';
import { keyManager } from './modules/keys/keyManager';
import { disabledControls } from './config/policy';
import router from './api/routes';
import attackRouter from './api/attackRoutes';
import demoSessionRouter from './modules/attacks/demoSessionReveal';
import { errorHandler } from './api/middleware/errorHandler';
import { attachSession } from './api/middleware/session';
import pool from './db/pool';
import redis from './utils/redis';

const app: Application = express();

/*
 * The LAN/tunnel demo serves the frontend through Vite, which proxies /api
 * here. Without this, every laptop arrives as 127.0.0.1 and they all share a
 * single rate-limit bucket — one person's step-up attempts lock out everyone
 * else. `1` means "one proxy hop", so req.ip is the last X-Forwarded-For
 * entry, the one Vite appended. A client that forges its own header cannot
 * shift that, so rate limits stay per-device and unspoofable.
 *
 * Requires xfwd:true on the Vite proxy (see frontend/vite.config.ts).
 */
app.set('trust proxy', 1);

app.use(helmet());
// Credentials must be allowed for the session cookie to travel. WEBAUTHN_EXPECTED_ORIGIN
// may list multiple origins (see config/env.ts) so an LAN/HTTPS demo origin can be
// trusted alongside http://localhost:5173 without touching this file.
app.use(cors({ origin: config.webauthn.expectedOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Populates req.userId from the signed cookie. Every route below reads the
// user from here and never from a request body.
app.use(attachSession);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ ok: true, service: 'prism', db: 'up', redis: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

// Mounted before the payment router so the payment path's rate-limit budget
// (router.use(defaultLimiter) inside routes.ts) never applies to attack-dashboard
// traffic — it has its own limiter (attackLimiter) applied inside attackRoutes.ts.
app.use('/api/v1/attacks', attackRouter);
// Separate from /api/v1/attacks: this is the VICTIM device revealing its own
// session for the demo, not the operator console — see demoSessionReveal.ts
// for why it is gated independently and never reachable in production.
app.use('/api/v1/demo', demoSessionRouter);
/**
 * The published Ed25519 key that signs step-up challenge tokens.
 *
 * The Authenticator app fetches this once at pairing and verifies every token
 * before showing a payee and amount. Without that check, anyone who can render
 * a QR controls what the second device displays — which is precisely the fraud
 * the second device exists to catch. Public half only: verification needs
 * nothing secret, which is why this route has no session guard.
 */
app.get('/.well-known/prism-keys', async (_req, res) => {
  const key = await keyManager.qrPublicKey();
  res.json({ keys: [key] });
});

app.use('/api/v1', router);
app.use(errorHandler);

async function start() {
  // Fail loudly at boot rather than on the first payment.
  await pool.query('SELECT 1');
  await redis.ping();

  const disabled = [...disabledControls()];
  if (disabled.length) {
    console.warn(`[PRISM] ⚠  DEMO MODE — controls disabled: ${disabled.join(', ')}`);
    console.warn('[PRISM] ⚠  This build is deliberately weakened. Never ship it.');
  }

  // Optional HTTPS for the 3-laptop LAN demo (see docs/LAN_DEMO_SETUP.md) — a
  // browser can only complete a real WebAuthn ceremony in a "secure context"
  // (HTTPS, or literally localhost). Absent these two env vars, behavior is
  // unchanged: plain HTTP, exactly as today.
  const { TLS_CERT_PATH, TLS_KEY_PATH } = process.env;
  const server =
    TLS_CERT_PATH && TLS_KEY_PATH
      ? https
          .createServer({ cert: fs.readFileSync(TLS_CERT_PATH), key: fs.readFileSync(TLS_KEY_PATH) }, app)
          .listen(config.port, () => {
            console.log(`[PRISM] IntentLock monolith listening on :${config.port} (HTTPS)`);
            console.log(`[PRISM] RP ID ${config.webauthn.rpId} · origins ${config.webauthn.expectedOrigins.join(', ')}`);
          })
      : app.listen(config.port, () => {
          console.log(`[PRISM] IntentLock monolith listening on :${config.port}`);
          console.log(`[PRISM] RP ID ${config.webauthn.rpId} · origins ${config.webauthn.expectedOrigins.join(', ')}`);
        });

  const shutdown = async () => {
    console.log('\n[PRISM] Shutting down...');
    server.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[PRISM] Failed to start:', err.message);
  console.error('[PRISM] Is Postgres/Redis up?  docker compose up postgres redis -d');
  process.exit(1);
});
