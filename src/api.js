import http from 'node:http';
import { assertRequestShape, assertWriteRateLimit, pruneRateLimitBuckets } from './api-security.js';
import { config } from './config.js';
import { handleAppRoutes } from './app-routes.js';
import { safeErrorStack } from './log-utils.js';
import { sendJson } from './response-utils.js';
import { serveGeneratedThumbnail } from './static-thumbnail-service.js';
import { waitForDb } from './db.js';

const server = http.createServer(async (req, res) => {
  try {
    assertRequestShape(req);
    assertWriteRateLimit(req);

    const requestUrl = new URL(req.url, config.publicBaseUrl);
    if (serveGeneratedThumbnail(requestUrl.pathname, res)) {
      return;
    }

    if (await handleAppRoutes({ requestUrl, req, res })) {
      return;
    }

    sendJson(res, { error: 'not_found' }, 404);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    if (statusCode >= 500) {
      console.error(`Unhandled API error: ${safeErrorStack(error)}`);
    }
    sendJson(res, {
      error: statusCode >= 500 ? 'internal_error' : 'bad_request',
      message: statusCode >= 500 ? 'Internal server error' : error.message,
    }, statusCode);
  }
});

server.requestTimeout = config.apiRequestTimeoutMs;
server.headersTimeout = config.apiHeadersTimeoutMs;
server.keepAliveTimeout = config.apiKeepAliveTimeoutMs;
server.maxHeadersCount = 100;

setInterval(pruneRateLimitBuckets, Math.max(1000, config.apiWriteRateLimitWindowMs)).unref();

async function main() {
  await waitForDb({ component: 'api' });
  server.listen(config.apiPort, () => {
    console.log(`SignalRSS API listening on :${config.apiPort}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
