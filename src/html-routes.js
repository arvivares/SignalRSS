import { config } from './config.js';
import { briefingConfigs } from './briefing-service.js';
import { renderBriefingsPage } from './briefing-pages.js';
import { renderClusterDetailPage, renderClustersPage, renderImpactPage } from './cluster-pages.js';
import { renderDashboardPage } from './dashboard-page.js';
import { renderLayout } from './layout-page.js';
import { renderNewsPage } from './news-page.js';
import { sendHtml } from './response-utils.js';
import { DEFAULT_CATEGORY, boundedIntParam } from './route-utils.js';

export async function handleHtmlRoutes({ requestUrl, res }) {
  if (requestUrl.pathname === '/') {
    const html = await renderDashboardPage({ renderLayout });
    sendHtml(res, html);
    return true;
  }

  if (requestUrl.pathname === '/news') {
    const html = await renderNewsPage({ renderLayout });
    sendHtml(res, html);
    return true;
  }

  if (requestUrl.pathname === '/clusters') {
    const html = await renderClustersPage({
      renderLayout,
      category: requestUrl.searchParams.get('category'),
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 50, 200),
    });
    sendHtml(res, html);
    return true;
  }

  if (requestUrl.pathname === '/impact') {
    const html = await renderImpactPage({
      renderLayout,
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
      level: requestUrl.searchParams.get('level'),
      hours: boundedIntParam(requestUrl.searchParams, 'hours', config.impactWindowHours, 168),
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 50, 200),
    });
    sendHtml(res, html);
    return true;
  }

  const categorizedBriefingPageMatch = requestUrl.pathname.match(/^\/([a-z0-9-]+)\/p([0-3])$/);
  if (categorizedBriefingPageMatch && !['api', 'rss'].includes(categorizedBriefingPageMatch[1])) {
    const category = categorizedBriefingPageMatch[1];
    const level = `P${categorizedBriefingPageMatch[2]}`;
    const briefingConfig = briefingConfigs[level];
    const html = await renderBriefingsPage({
      renderLayout,
      level,
      category,
      hours: boundedIntParam(requestUrl.searchParams, 'hours', briefingConfig.defaultHours(), 168),
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 50, 200),
      page: boundedIntParam(requestUrl.searchParams, 'page', 1, Number.MAX_SAFE_INTEGER),
    });
    sendHtml(res, html);
    return true;
  }

  const briefingPageMatch = requestUrl.pathname.match(/^\/p([0-3])$/);
  if (briefingPageMatch) {
    const level = `P${briefingPageMatch[1]}`;
    const briefingConfig = briefingConfigs[level];
    const html = await renderBriefingsPage({
      renderLayout,
      level,
      category: requestUrl.searchParams.get('category') || DEFAULT_CATEGORY,
      hours: boundedIntParam(requestUrl.searchParams, 'hours', briefingConfig.defaultHours(), 168),
      limit: boundedIntParam(requestUrl.searchParams, 'limit', 50, 200),
      page: boundedIntParam(requestUrl.searchParams, 'page', 1, Number.MAX_SAFE_INTEGER),
    });
    sendHtml(res, html);
    return true;
  }

  const clusterPageMatch = requestUrl.pathname.match(/^\/clusters\/([0-9a-f-]{36})$/);
  if (clusterPageMatch) {
    const html = await renderClusterDetailPage({ renderLayout, id: clusterPageMatch[1] });
    sendHtml(res, html);
    return true;
  }

  return false;
}
