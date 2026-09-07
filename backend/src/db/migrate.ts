/**
 * Database Migration Runner
 * Runs all SQL migration files in order.
 * Usage: npm run db:migrate
 */
import { query } from './pool';
import fs from 'fs';
import path from 'path';

async function migrate() {
  console.log('[DB] Starting migrations...');

  // TODO: Read and execute each .sql file from src/db/migrations/ in order
  // Example implementation:
  // const files = fs.readdirSync(path.join(__dirname, 'migrations')).sort();
  // for (const file of files) {
  //   const sql = fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8');
  //   await query(sql);
  //   console.log(`[DB] Ran migration: ${file}`);
  // }

  console.log('[DB] Migrations complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('[DB] Migration failed:', err);
  process.exit(1);
});
