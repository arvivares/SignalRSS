import { handleBriefingRoutes } from './briefing-routes.js';
import { handleClusterRoutes } from './cluster-routes.js';
import { handleHealthRoutes } from './health-routes.js';
import { handleHtmlRoutes } from './html-routes.js';
import { handleNewsRoutes } from './news-routes.js';
import { handleRssRoutes } from './rss-routes.js';
import { handleStatsRoutes } from './stats-routes.js';

const routeHandlers = [
  handleHealthRoutes,
  handleHtmlRoutes,
  handleRssRoutes,
  handleStatsRoutes,
  handleClusterRoutes,
  handleNewsRoutes,
  handleBriefingRoutes,
];

export async function handleAppRoutes(context) {
  for (const handleRoute of routeHandlers) {
    if (await handleRoute(context)) {
      return true;
    }
  }

  return false;
}
