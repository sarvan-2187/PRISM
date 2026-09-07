import { Pool, PoolClient } from 'pg';

/**
 * PostgreSQL connection pool.
 * Single shared pool for the entire monolithic application.
 * All modules import this pool — never create new Pool instances elsewhere.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                  // max connections in pool
  idleTimeoutMillis: 30000, // close idle clients after 30s
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
  process.exit(1);
});

/**
 * Run a query on the shared pool.
 */
export const query = <T = any>(
  text: string,
  params?: any[]
): Promise<import('pg').QueryResult<T>> => pool.query<T>(text, params);

/**
 * Acquire a client for a multi-statement transaction (ACID).
 * Always wrap in try/finally and call client.release().
 */
export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
