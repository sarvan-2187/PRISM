import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';

/**
 * PostgreSQL connection pool.
 * Single shared pool for the entire monolithic application.
 * All modules import this pool — never create new Pool instances elsewhere.
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,                  // max connections in pool
  idleTimeoutMillis: 30000, // close idle clients after 30s
  connectionTimeoutMillis: 2000,
});

// Log and carry on. An idle-client error is usually transient, and killing the
// process mid-demo is a worse failure than the one we are reacting to.
pool.on('error', (err) => {
  console.error('[DB] Unexpected idle client error:', err.message);
});

/**
 * Run a query on the shared pool.
 */
export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => pool.query<T>(text, params);

/**
 * Acquire a client for a multi-statement transaction (ACID).
 * Always wrap in try/finally and call client.release().
 */
export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
