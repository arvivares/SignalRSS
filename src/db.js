import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export async function waitForDb({ component = 'database', timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      await pool.query('SELECT 1');
      if (attempts > 1) console.log(`${component}: database ready after ${attempts} attempts`);
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${component}: database not ready after ${attempts} attempts: ${error.message}`);
      }
      console.warn(`${component}: waiting for database: ${error.message}`);
      await sleep(intervalMs);
    }
  }
}

export async function closeDb() {
  await pool.end();
}
