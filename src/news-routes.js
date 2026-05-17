import { buildInterestedNews, buildNewsQueue, recordNewsSwipe } from './news-service.js';
import { readJsonBody } from './request-utils.js';
import { sendJson } from './response-utils.js';
import { boundedIntParam } from './route-utils.js';

export async function handleNewsRoutes({ requestUrl, req, res }) {
  if (requestUrl.pathname === '/api/news' && req.method === 'GET') {
    const data = await buildNewsQueue({
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 40, 200),
      hours: boundedIntParam(requestUrl.searchParams, 'hours', 168, 168),
      level: requestUrl.searchParams.get('level'),
    });
    sendJson(res, { data });
    return true;
  }

  if (requestUrl.pathname === '/api/news/swipe' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const row = await recordNewsSwipe({
      clusterId: body.cluster_id,
      action: body.action,
    });
    sendJson(res, { data: row });
    return true;
  }

  if (requestUrl.pathname === '/api/news/interested' && req.method === 'GET') {
    const data = await buildInterestedNews({
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 100, 500),
    });
    sendJson(res, { data });
    return true;
  }

  return false;
}
