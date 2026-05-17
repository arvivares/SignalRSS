import crypto from 'node:crypto';

export function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function cleanTextNoNull(value = '') {
  return String(value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

export function hashInput(value, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

export function hostFromUrl(value = '') {
  if (!value) return '';
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function sanitizeJsonValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key.replace(/\u0000/g, ''),
        sanitizeJsonValue(nestedValue),
      ]),
    );
  }
  return value;
}
