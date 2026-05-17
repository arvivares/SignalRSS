import { config } from './config.js';
import { buildClusters, buildImpactClusters } from './cluster-service.js';
import { sendJson } from './response-utils.js';
import { DEFAULT_CATEGORY, boundedIntParam } from './route-utils.js';

export async function handleClusterRoutes({ requestUrl, res }) {
  if (requestUrl.pathname === '/api/clusters') {
    const limit = boundedIntParam(requestUrl.searchParams, 'limit', 50, 200);
    const clusters = await buildClusters({
      category: requestUrl.searchParams.get('category'),
      limit,
    });
    sendJson(res, { data: clusters });
    return true;
  }

  if (requestUrl.pathname === '/api/impact') {
    const limit = boundedIntParam(requestUrl.searchParams, 'limit', 50, 200);
    const clusters = await buildImpactClusters({
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
      level: requestUrl.searchParams.get('level'),
      hours: boundedIntParam(requestUrl.searchParams, 'hours', config.impactWindowHours, 168),
      limit,
    });
    sendJson(res, { data: clusters });
    return true;
  }

  return false;
}
