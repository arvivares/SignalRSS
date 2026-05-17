import {
  buildCategoryStats,
  buildClassificationStats,
  buildClusterStats,
  buildFeedStats,
  buildImpactStats,
  buildOpsHealth,
} from './stats-service.js';
import { sendJson } from './response-utils.js';
import { DEFAULT_CATEGORY, boundedIntParam } from './route-utils.js';

export async function handleStatsRoutes({ requestUrl, res }) {
  if (requestUrl.pathname === '/feeds/stats') {
    const stats = await buildFeedStats();
    sendJson(res, stats);
    return true;
  }

  if (requestUrl.pathname === '/categories/stats') {
    const stats = await buildCategoryStats();
    sendJson(res, stats);
    return true;
  }

  if (requestUrl.pathname === '/classification/stats') {
    const stats = await buildClassificationStats();
    sendJson(res, stats);
    return true;
  }

  if (requestUrl.pathname === '/clusters/stats') {
    const stats = await buildClusterStats();
    sendJson(res, stats);
    return true;
  }

  if (requestUrl.pathname === '/impact/stats') {
    const stats = await buildImpactStats({
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
      hours: boundedIntParam(requestUrl.searchParams, 'hours', 24, 168),
    });
    sendJson(res, stats);
    return true;
  }

  if (requestUrl.pathname === '/api/ops/health') {
    const stats = await buildOpsHealth();
    sendJson(res, stats, stats.status === 'ok' ? 200 : 503);
    return true;
  }

  return false;
}
