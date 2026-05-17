import { buildGroupsRss, buildRss } from './rss-service.js';
import { sendRss } from './response-utils.js';

export async function handleRssRoutes({ requestUrl, res }) {
  if (requestUrl.pathname === '/rss.xml') {
    const xml = await buildRss({ category: requestUrl.searchParams.get('category') });
    sendRss(res, xml);
    return true;
  }

  const categoryRssMatch = requestUrl.pathname.match(/^\/rss\/([a-z0-9-]+)\.xml$/);
  if (categoryRssMatch) {
    const xml = await buildRss({ category: categoryRssMatch[1] });
    sendRss(res, xml);
    return true;
  }

  if (requestUrl.pathname === '/groups.xml') {
    const xml = await buildGroupsRss({ category: requestUrl.searchParams.get('category') });
    sendRss(res, xml);
    return true;
  }

  return false;
}
