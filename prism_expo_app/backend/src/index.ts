/**
 * PRISM App backend.
 *
 * A second server on its own port, sharing the web backend's Postgres and
 * Redis. Sharing the database is the whole point: a payment made on the phone
 * has to land in the same ledger the website reads, or the two are unrelated
 * demos rather than one product.
 *
 * Nothing here re-implements money movement. The modules that decide whether
 * a payment settles are imported from ../../backend and run unchanged.
 */
import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';

import router from './routes';
import { ensureAppSchema } from './schema';
import { errorHandler } from '../../../backend/src/api/middleware/errorHandler';
import pool from '../../../backend/src/db/pool';
import redis from '../../../backend/src/utils/redis';

const PORT = Number(process.env.APP_API_PORT ?? 4100);

const app: Application = express();

// The LAN demo puts the phone on a different host from the server, and a
// native client sends no Origin header at all. CORS is not a control here:
// every route is guarded by a signed Bearer token, and there is no cookie for
// a hostile page to ride.
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ ok: true, service: 'prism-app', db: 'up', redis: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

app.use('/app/v1', router);
app.use(errorHandler);

async function start() {
  // Fail at boot rather than on the first payment.
  await pool.query('SELECT 1');
  await redis.ping();
  await ensureAppSchema();

  const server = app.listen(PORT, () => {
    console.log(`[PRISM App] API listening on :${PORT}`);
    console.log('[PRISM App] Sharing the web backend’s database and domain modules.');
  });

  const shutdown = async () => {
    console.log('\n[PRISM App] Shutting down...');
    server.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[PRISM App] Failed to start:', err.message);
  console.error('[PRISM App] Is the web stack up?  docker compose up postgres redis -d');
  process.exit(1);
});
