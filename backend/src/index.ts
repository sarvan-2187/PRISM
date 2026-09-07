import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import { disabledControls } from './config/policy';
import router from './api/routes';
import { errorHandler } from './api/middleware/errorHandler';
import { attachSession } from './api/middleware/session';
import pool from './db/pool';
import redis from './utils/redis';

const app: Application = express();

app.use(helmet());
// Credentials must be allowed for the session cookie to travel.
app.use(cors({ origin: config.webauthn.expectedOrigin, credentials: true }));
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

  const server = app.listen(config.port, () => {
    console.log(`[PRISM] IntentLock monolith listening on :${config.port}`);
    console.log(`[PRISM] RP ID ${config.webauthn.rpId} · origin ${config.webauthn.expectedOrigin}`);
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
