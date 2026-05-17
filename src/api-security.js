import { config } from './config.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const buckets = new Map();

function clientKey(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.socket.remoteAddress || 'unknown';
}

export function assertRequestShape(req) {
  if (String(req.url || '').length > config.apiMaxUrlLength) {
    const error = new Error('Request URL too long');
    error.statusCode = 414;
    throw error;
  }
}

export function assertWriteRateLimit(req) {
  if (!WRITE_METHODS.has(String(req.method || '').toUpperCase())) return;

  const now = Date.now();
  const windowMs = Math.max(1000, config.apiWriteRateLimitWindowMs);
  const maxRequests = Math.max(1, config.apiWriteRateLimitMax);
  const key = clientKey(req);
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    const error = new Error('Too many write requests');
    error.statusCode = 429;
    throw error;
  }
}

export function pruneRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
