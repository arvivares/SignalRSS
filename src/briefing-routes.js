import { briefingConfigs, buildBriefingDetail, buildBriefings } from './briefing-service.js';
import { sendJson } from './response-utils.js';
import { DEFAULT_CATEGORY, boundedIntParam } from './route-utils.js';

function briefingResponseMeta({ category, briefingConfig, result }) {
  return {
    category,
    locale: 'es',
    briefing_type: briefingConfig.type,
    count: result.items.length,
    total: result.total,
    page: result.page,
    limit: result.limit,
    pages: result.pages,
    order: 'latest_published_at_desc',
  };
}

async function sendBriefingList({ requestUrl, res, level, category }) {
  const briefingConfig = briefingConfigs[level];
  const limit = boundedIntParam(requestUrl.searchParams, 'limit', 50, 200);
  const result = await buildBriefings({
    level,
    category,
    hours: boundedIntParam(requestUrl.searchParams, 'hours', briefingConfig.defaultHours(), 168),
    limit,
    page: boundedIntParam(requestUrl.searchParams, 'page', 1, Number.MAX_SAFE_INTEGER),
  });
  sendJson(res, {
    meta: briefingResponseMeta({ category, briefingConfig, result }),
    data: result.items.map((briefing) => briefing.payload || briefing),
  });
}

async function sendBriefingDetail({ res, clusterId, level, category }) {
  const briefing = await buildBriefingDetail(clusterId, level, category);
  if (!briefing) {
    sendJson(res, { error: 'not_found' }, 404);
    return;
  }
  sendJson(res, { data: briefing.payload || briefing });
}

export async function handleBriefingRoutes({ requestUrl, res }) {
  const categorizedBriefingApiMatch = requestUrl.pathname.match(/^\/api\/([a-z0-9-]+)\/p([0-3])$/);
  if (categorizedBriefingApiMatch) {
    await sendBriefingList({
      requestUrl,
      res,
      category: categorizedBriefingApiMatch[1],
      level: `P${categorizedBriefingApiMatch[2]}`,
    });
    return true;
  }

  const briefingApiMatch = requestUrl.pathname.match(/^\/api\/p([0-3])$/);
  if (briefingApiMatch) {
    await sendBriefingList({
      requestUrl,
      res,
      level: `P${briefingApiMatch[1]}`,
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
    });
    return true;
  }

  const categorizedBriefingDetailApiMatch = requestUrl.pathname.match(/^\/api\/([a-z0-9-]+)\/p([0-3])\/([0-9a-f-]{36})$/);
  if (categorizedBriefingDetailApiMatch) {
    await sendBriefingDetail({
      res,
      category: categorizedBriefingDetailApiMatch[1],
      level: `P${categorizedBriefingDetailApiMatch[2]}`,
      clusterId: categorizedBriefingDetailApiMatch[3],
    });
    return true;
  }

  const briefingDetailApiMatch = requestUrl.pathname.match(/^\/api\/p([0-3])\/([0-9a-f-]{36})$/);
  if (briefingDetailApiMatch) {
    await sendBriefingDetail({
      res,
      level: `P${briefingDetailApiMatch[1]}`,
      clusterId: briefingDetailApiMatch[2],
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
    });
    return true;
  }

  return false;
}
