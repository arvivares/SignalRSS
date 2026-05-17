export async function readJsonBody(req, { maxBytes = 65536 } = {}) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    const error = new Error('Unsupported content type');
    error.statusCode = 415;
    throw error;
  }

  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    const text = chunk.toString('utf8');
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    body += text;
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}
