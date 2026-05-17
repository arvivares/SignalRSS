const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function withSecurityHeaders(headers = {}) {
  return {
    ...SECURITY_HEADERS,
    ...headers,
  };
}

export function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, withSecurityHeaders({ 'content-type': 'application/json' }));
  res.end(JSON.stringify(payload));
}

export function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, withSecurityHeaders({ 'content-type': 'text/html; charset=utf-8' }));
  res.end(html);
}

export function sendRss(res, xml, statusCode = 200) {
  res.writeHead(statusCode, withSecurityHeaders({ 'content-type': 'application/rss+xml; charset=utf-8' }));
  res.end(xml);
}

export { withSecurityHeaders };
