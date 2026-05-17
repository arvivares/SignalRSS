import http from 'node:http';
import { config } from './config.js';
import { handleAppRoutes } from './app-routes.js';
import { sendJson } from './response-utils.js';
import { serveGeneratedThumbnail } from './static-thumbnail-service.js';

const server = http.createServer(async (req, res) => {
  try {
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
    sendJson(res, {
      error: statusCode >= 500 ? 'internal_error' : 'bad_request',
      message: error.message,
    }, statusCode);
  }
});

server.listen(config.apiPort, () => {
  console.log(`SignalRSS API listening on :${config.apiPort}`);
});
