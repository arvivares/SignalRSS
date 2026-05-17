import Parser from 'rss-parser';
import { pool } from './db.js';
import { fetchWithTimeout } from './http-utils.js';
import { hashInput } from './text-utils.js';

const parser = new Parser({
  requestOptions: {
    timeout: 60000,
    rejectUnauthorized: true,
  },
  headers: {
    Accept: 'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4',
  },
});

const FEED_FETCH_TIMEOUT_MS = 60000;
const FEED_ACCEPT_HEADER = 'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4';

export function cutoffDate(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function parseItemDate(item) {
  const value = item.isoDate || item.pubDate || item.date || item.published || item.updated;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hostFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeItem(item) {
  const canonicalUrl = text(item.link);
  const guid = text(item.guid || item.id);
  const title = text(item.title);
  const summary = text(item.contentSnippet || item.summary || item.description);
  const content = text(item.content || item['content:encoded']);
  const author = text(item.creator || item.author || item['dc:creator']);
  const publishedAt = parseItemDate(item);
  const contentHashInput = [guid, canonicalUrl, title, publishedAt?.toISOString() || ''].join('|');

  return {
    guid: guid || null,
    canonicalUrl: canonicalUrl || null,
    sourceHost: hostFromUrl(canonicalUrl),
    title,
    summary: summary || null,
    content: content || null,
    author: author || null,
    publishedAt,
    contentHash: hashInput(contentHashInput),
    rawJson: item,
  };
}

async function fetchFeedXml(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: FEED_ACCEPT_HEADER,
      'User-Agent': 'SignalRSS/0.1 (+https://signalrss.local)',
    },
    timeoutMs: FEED_FETCH_TIMEOUT_MS,
    timeoutMessage: `Request timed out after ${FEED_FETCH_TIMEOUT_MS}ms`,
  });
  if (!response.ok) throw new Error(`Status code ${response.status}`);
  return (await response.text()).replace(/^\uFEFF/, '').trimStart();
}

async function parseFeedUrl(url) {
  const xml = await fetchFeedXml(url);
  return parser.parseString(xml);
}

async function findArticle(client, article) {
  const { rows } = await client.query(
    `SELECT id
     FROM articles
     WHERE ($1::text IS NOT NULL AND guid = $1)
        OR ($2::text IS NOT NULL AND canonical_url = $2)
        OR content_hash = $3
     LIMIT 1`,
    [article.guid, article.canonicalUrl, article.contentHash],
  );
  return rows[0]?.id || null;
}

async function upsertArticle(client, article) {
  const existingId = await findArticle(client, article);
  if (existingId) {
    await client.query(
      `UPDATE articles
       SET updated_at = NOW()
       WHERE id = $1`,
      [existingId],
    );
    return { articleId: existingId, inserted: false };
  }

  await client.query('SAVEPOINT insert_article');
  try {
    const { rows } = await client.query(
      `INSERT INTO articles (
         guid, canonical_url, source_host, title, summary, content, author, published_at, content_hash, raw_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        article.guid,
        article.canonicalUrl,
        article.sourceHost,
        article.title,
        article.summary,
        article.content,
        article.author,
        article.publishedAt,
        article.contentHash,
        article.rawJson,
      ],
    );
    await client.query('RELEASE SAVEPOINT insert_article');
    return { articleId: rows[0].id, inserted: true };
  } catch (error) {
    if (error.code !== '23505') throw error;
    await client.query('ROLLBACK TO SAVEPOINT insert_article');
    const articleId = await findArticle(client, article);
    if (!articleId) throw error;
    return { articleId, inserted: false };
  }
}

async function linkFeedEntry(client, feed, article, articleId) {
  await client.query(
    `INSERT INTO feed_entries (feed_id, article_id, source_guid, source_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (feed_id, article_id) DO NOTHING`,
    [feed.id, articleId, article.guid, article.canonicalUrl],
  );
}

export async function fetchAndStoreFeed(feed, { since = cutoffDate(7), until = new Date() } = {}) {
  const startedAt = new Date();
  let parsed;
  try {
    parsed = await parseFeedUrl(feed.url);
  } catch (error) {
    await pool.query(
      `UPDATE feeds
       SET last_fetch_at = NOW(), last_status = 'failed',
           last_error = $2, fail_count = fail_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [feed.id, error.message],
    );
    await pool.query(
      `INSERT INTO fetch_runs (feed_id, started_at, finished_at, status, error)
       VALUES ($1, $2, NOW(), 'failed', $3)`,
      [feed.id, startedAt, error.message],
    );
    return { status: 'failed', error: error.message, itemsFound: 0, itemsConsidered: 0, itemsInserted: 0, itemsLinked: 0 };
  }

  const items = parsed.items || [];
  let considered = 0;
  let inserted = 0;
  let linked = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of items) {
      const article = normalizeItem(item);
      if (!article.title || !article.publishedAt || article.publishedAt < since || article.publishedAt > until) continue;

      considered += 1;
      const result = await upsertArticle(client, article);
      if (result.inserted) inserted += 1;
      await linkFeedEntry(client, feed, article, result.articleId);
      linked += 1;
    }

    await client.query(
      `UPDATE feeds
       SET last_fetch_at = NOW(), last_success_at = NOW(), last_status = 'ok',
           last_error = NULL, fail_count = 0, updated_at = NOW()
       WHERE id = $1`,
      [feed.id],
    );
    await client.query(
      `INSERT INTO fetch_runs (feed_id, started_at, finished_at, status, items_found, items_inserted)
       VALUES ($1, $2, NOW(), 'ok', $3, $4)`,
      [feed.id, startedAt, items.length, inserted],
    );

    await client.query('COMMIT');
    return { status: 'ok', itemsFound: items.length, itemsConsidered: considered, itemsInserted: inserted, itemsLinked: linked };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE feeds
       SET last_fetch_at = NOW(), last_status = 'failed',
           last_error = $2, fail_count = fail_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [feed.id, error.message],
    );
    await pool.query(
      `INSERT INTO fetch_runs (feed_id, started_at, finished_at, status, error)
       VALUES ($1, $2, NOW(), 'failed', $3)`,
      [feed.id, startedAt, error.message],
    );
    return { status: 'failed', error: error.message, itemsFound: 0, itemsConsidered: 0, itemsInserted: 0, itemsLinked: 0 };
  } finally {
    client.release();
  }
}

export async function loadFeeds({ limit = null, all = false } = {}) {
  const params = [];
  const limitSql = all ? '' : 'LIMIT $1';
  if (!all) params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, name, url
     FROM feeds
     WHERE enabled = TRUE
     ORDER BY last_fetch_at ASC NULLS FIRST, name ASC
     ${limitSql}`,
    params,
  );
  return rows;
}
