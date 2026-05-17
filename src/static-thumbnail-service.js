import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { withSecurityHeaders } from './response-utils.js';

function generatedThumbnailFilePath(pathname) {
  const publicPath = config.mattermostGeneratedThumbnailPublicPath.replace(/\/$/, '');
  if (!pathname.startsWith(`${publicPath}/`)) return null;

  const filename = path.basename(pathname.slice(publicPath.length + 1));
  if (!/^[0-9a-f-]{36}\.png$/i.test(filename)) return null;

  const resolved = path.resolve(config.mattermostGeneratedThumbnailDir, filename);
  const root = path.resolve(config.mattermostGeneratedThumbnailDir);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function serveGeneratedThumbnail(pathname, res) {
  const thumbnailPath = generatedThumbnailFilePath(pathname);
  if (!thumbnailPath) return false;

  if (!fs.existsSync(thumbnailPath)) {
    res.writeHead(404, withSecurityHeaders({ 'content-type': 'application/json' }));
    res.end(JSON.stringify({ error: 'not_found' }));
    return true;
  }

  res.writeHead(200, withSecurityHeaders({
    'content-type': 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
  }));
  fs.createReadStream(thumbnailPath).pipe(res);
  return true;
}
