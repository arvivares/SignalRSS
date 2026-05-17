import { config } from './config.js';
import { pool } from './db.js';

function escapeXml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatUtc(value) {
  if (!value) return null;
  return new Date(value).toUTCString();
}

function hostFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function buildRss({ category = null } = {}) {
  const params = [];
  let categoryJoin = '';
  let categoryFilter = '';

  if (category) {
    params.push(category);
    categoryJoin = `
      JOIN article_classifications ac ON ac.article_id = a.id AND ac.rank = 1
      JOIN topic_categories tc ON tc.id = ac.category_id`;
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT a.title, a.summary, a.canonical_url, a.published_at, a.first_seen_at
    FROM articles a
    ${categoryJoin}
    WHERE a.published_at >= NOW() - INTERVAL '7 days'
      AND a.published_at <= NOW()
      ${categoryFilter}
    ORDER BY a.published_at DESC NULLS LAST, a.first_seen_at DESC
    LIMIT 200
  `, params);

  const items = rows.map((article) => {
    const link = article.canonical_url || config.publicBaseUrl;
    const pubDate = new Date(article.published_at || article.first_seen_at).toUTCString();
    return `
      <item>
        <title>${escapeXml(article.title)}</title>
        <link>${escapeXml(link)}</link>
        <guid>${escapeXml(link)}</guid>
        <pubDate>${escapeXml(pubDate)}</pubDate>
        <description>${escapeXml(article.summary || '')}</description>
      </item>`;
  }).join('');

  const title = category ? `SignalRSS - ${category}` : 'SignalRSS';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(config.publicBaseUrl)}</link>
    <description>Unified global technology news feed.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

export async function buildGroupsRss({ category = null } = {}) {
  const params = [];
  let categoryFilter = '';

  if (category) {
    params.push(category);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    WITH cluster_items AS (
      SELECT
        sc.id,
        sc.title,
        sc.summary,
        sc.article_count,
        sc.first_published_at,
        sc.latest_published_at,
        tc.slug AS category_slug,
        tc.name AS category_name,
        rep.canonical_url AS representative_url,
        avg(ca.similarity)::float AS avg_similarity,
        min(ca.similarity)::float AS min_similarity,
        count(DISTINCT a.source_host)::int AS source_count,
        json_agg(
          json_build_object(
            'title', a.title,
            'url', a.canonical_url,
            'published_at', a.published_at,
            'source', a.source_host
          )
          ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
        ) AS articles
      FROM story_clusters sc
      LEFT JOIN topic_categories tc ON tc.id = sc.category_id
      LEFT JOIN articles rep ON rep.id = sc.representative_article_id
      JOIN cluster_articles ca ON ca.cluster_id = sc.id
      JOIN articles a ON a.id = ca.article_id
      WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
        ${categoryFilter}
      GROUP BY sc.id, tc.slug, tc.name, rep.canonical_url
    )
    SELECT *
    FROM cluster_items
    ORDER BY latest_published_at DESC NULLS LAST, id DESC
    LIMIT 200
  `, params);

  const items = rows.map((cluster) => {
    const link = cluster.representative_url || `${config.publicBaseUrl}/clusters/${cluster.id}`;
    const pubDate = new Date(cluster.latest_published_at || Date.now()).toUTCString();
    const relatedLinks = (cluster.articles || [])
      .slice(0, 5)
      .map((article, index) => `${index + 1}. ${article.title} (${article.source || hostFromUrl(article.url) || 'source'}): ${article.url}`)
      .join('\n');
    const description = [
      cluster.summary || '',
      `Category: ${cluster.category_name || 'Uncategorized'} (${cluster.category_slug || 'uncategorized'}).`,
      `Related articles: ${cluster.article_count}. Sources: ${cluster.source_count || 0}.`,
      `Published window: ${formatUtc(cluster.first_published_at) || 'unknown'} - ${formatUtc(cluster.latest_published_at) || 'unknown'}.`,
      `Similarity: avg ${Number(cluster.avg_similarity || 0).toFixed(3)}, min ${Number(cluster.min_similarity || 0).toFixed(3)}.`,
      relatedLinks ? `Top related links:\n${relatedLinks}` : '',
    ].filter(Boolean).join('\n\n');

    return `
      <item>
        <title>${escapeXml(cluster.title)}</title>
        <link>${escapeXml(link)}</link>
        <guid isPermaLink="false">${escapeXml(cluster.id)}</guid>
        <pubDate>${escapeXml(pubDate)}</pubDate>
        <description>${escapeXml(description)}</description>
      </item>`;
  }).join('');

  const title = category ? `SignalRSS Groups - ${category}` : 'SignalRSS Groups';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(config.publicBaseUrl)}</link>
    <description>Grouped global technology news stories.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}
