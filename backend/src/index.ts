import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env';
import router from './api/routes';
import { errorHandler } from './api/middleware/errorHandler';
import pool from './db/pool';
import redis from './utils/redis';

const app: Application = express();

// Security headers
app.use(helmet());

// CORS — tighten allowed origins in production
app.use(cors({ origin: config.webauthn.expectedOrigin, credentials: true }));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Gateway entry point
app.use('/api/v1', router);

// Global error handler (must be last)
app.use(errorHandler);

// Startup
const server = app.listen(config.port, async () => {
  // Verify DB connection
  await pool.query('SELECT 1');
  console.log(`[PRISM] IntentLock Monolithic Application running on port ${config.port}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('[PRISM] Shutting down...');
  server.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
