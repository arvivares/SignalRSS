import { pool } from './db.js';
import { sendJson } from './response-utils.js';

export async function handleHealthRoutes({ requestUrl, res }) {
  if (requestUrl.pathname === '/health' || requestUrl.pathname === '/api/health') {
    sendJson(res, { status: 'ok', service: 'signalrss-api' });
    return true;
  }

  if (requestUrl.pathname === '/ready' || requestUrl.pathname === '/api/ready') {
    await pool.query('SELECT 1');
    sendJson(res, { status: 'ready', service: 'signalrss-api', database: 'ok' });
    return true;
  }

  return false;
}
