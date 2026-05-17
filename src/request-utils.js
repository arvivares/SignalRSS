export async function readJsonBody(req, { maxBytes = 65536 } = {}) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body.trim()) return {};
  return JSON.parse(body);
}
