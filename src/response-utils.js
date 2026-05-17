export function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function sendRss(res, xml, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'application/rss+xml; charset=utf-8' });
  res.end(xml);
}
