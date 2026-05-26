import { config } from './config.js';
import { pool } from './db.js';

export async function quarantineLowQualityFeeds() {
  if (!config.feedQuarantineEnabled) return { disabled: 0, rows: [] };

  const { rows } = await pool.query(
    `
      WITH feed_articles AS (
        SELECT
          f.id AS feed_id,
          a.id AS article_id
        FROM feeds f
        LEFT JOIN feed_entries fe ON fe.feed_id = f.id
        LEFT JOIN articles a
          ON a.id = fe.article_id
         AND a.published_at >= NOW() - ($1::int * INTERVAL '1 day')
        WHERE f.enabled = TRUE
      ),
      classified AS (
        SELECT article_id
        FROM article_classifications
        WHERE rank = 1
        GROUP BY article_id
      ),
      rejected AS (
        SELECT article_id
        FROM article_classification_rejections
        GROUP BY article_id
      ),
      per_feed AS (
        SELECT
          f.id,
          f.name,
          f.url,
          f.last_status,
          f.fail_count,
          count(DISTINCT fa.article_id) FILTER (WHERE fa.article_id IS NOT NULL)::int AS articles,
          count(DISTINCT fa.article_id) FILTER (WHERE c.article_id IS NOT NULL)::int AS classified,
          count(DISTINCT fa.article_id) FILTER (WHERE r.article_id IS NOT NULL)::int AS rejected
        FROM feeds f
        LEFT JOIN feed_articles fa ON fa.feed_id = f.id
        LEFT JOIN classified c ON c.article_id = fa.article_id
        LEFT JOIN rejected r ON r.article_id = fa.article_id
        WHERE f.enabled = TRUE
        GROUP BY f.id, f.name, f.url, f.last_status, f.fail_count
      ),
      candidates AS (
        SELECT
          id,
          CASE
            WHEN last_status <> 'ok' AND fail_count >= $2
              THEN 'technical-failure'
            WHEN articles >= $3 AND rejected::numeric / NULLIF(articles, 0) >= $4
              THEN 'high-rejection'
          END AS quarantine_reason
        FROM per_feed
      )
      UPDATE feeds f
         SET enabled = FALSE,
             updated_at = NOW(),
             last_error = concat_ws(
               '; ',
               NULLIF(f.last_error, ''),
               'auto-quarantined: ' || c.quarantine_reason
             )
      FROM candidates c
      WHERE f.id = c.id
        AND c.quarantine_reason IS NOT NULL
      RETURNING f.name, f.url, c.quarantine_reason AS reason
    `,
    [
      config.feedQuarantineWindowDays,
      config.feedQuarantineFailCount,
      config.feedQuarantineMinArticles,
      config.feedQuarantineRejectionRatio,
    ],
  );

  return { disabled: rows.length, rows };
}
