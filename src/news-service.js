import { pool } from './db.js';
import { storyHashFromParts } from './story-hash.js';
import { isBriefingExcluded } from './briefing-exclusions.js';

const PRIORITY_LEVELS = ['P0', 'P1', 'P2', 'P3'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizePriorityLevels(level) {
  if (!level) return PRIORITY_LEVELS;
  const normalized = String(level).toUpperCase();
  return PRIORITY_LEVELS.includes(normalized) ? [normalized] : PRIORITY_LEVELS;
}

export async function buildNewsQueue({ limit = 40, hours = 168, level = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const safeHours = Math.min(Math.max(Number(hours) || 168, 1), 168);
  const levels = normalizePriorityLevels(level);
  const { rows } = await pool.query(`
    WITH briefings AS (
      SELECT
        cb.cluster_id,
        cb.locale,
        cb.briefing_type,
        cb.story_hash,
        cb.title,
        cb.summary,
        cb.links,
        cb.generated_at,
        sc.latest_published_at,
        tc.slug AS category_slug,
        tc.name AS category_name,
        cis.impact_level,
        cis.impact_score,
        cis.impact_category,
        row_number() OVER (
          PARTITION BY cb.cluster_id
          ORDER BY
            CASE cis.impact_level WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 WHEN 'P2' THEN 3 ELSE 4 END,
            cb.generated_at DESC
        ) AS rn
      FROM cluster_briefings cb
      JOIN story_clusters sc ON sc.id = cb.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE cb.locale = 'es'
        AND cis.impact_level = ANY($2::text[])
        AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
        AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND sc.latest_published_at <= NOW()
    )
    SELECT b.*
    FROM briefings b
    LEFT JOIN news_swipes ns
      ON ns.story_hash = b.story_hash
      AND ns.locale = b.locale
    WHERE b.rn = 1
      AND ns.id IS NULL
    ORDER BY
      b.latest_published_at DESC NULLS LAST,
      b.impact_score DESC,
      b.cluster_id DESC
    LIMIT $3
  `, [safeHours, levels, safeLimit]);

  return rows
    .filter((row) => !isBriefingExcluded(row.category_slug, row.impact_level))
    .map((row) => ({
      cluster_id: row.cluster_id,
      story_hash: row.story_hash,
      title: row.title,
      summary: row.summary,
      links: row.links || [],
      category_slug: row.category_slug,
      category_name: row.category_name,
      impact_level: row.impact_level,
      impact_score: row.impact_score,
      impact_category: row.impact_category,
      briefing_type: row.briefing_type,
      latest_published_at: row.latest_published_at,
      generated_at: row.generated_at,
    }));
}

export async function recordNewsSwipe({ clusterId, action }) {
  if (!UUID_REGEX.test(String(clusterId || ''))) {
    const error = new Error('Invalid cluster_id');
    error.statusCode = 400;
    throw error;
  }

  if (!['interested', 'dismissed'].includes(action)) {
    const error = new Error('Invalid action');
    error.statusCode = 400;
    throw error;
  }

  const { rows } = await pool.query(`
    SELECT
      cb.cluster_id,
      cb.locale,
      cb.briefing_type,
      cb.story_hash,
      cb.title,
      cb.summary,
      cb.links,
      sc.latest_published_at,
      tc.slug AS category_slug,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category
    FROM cluster_briefings cb
    JOIN story_clusters sc ON sc.id = cb.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cb.cluster_id = $1
      AND cb.locale = 'es'
      AND cis.impact_level = ANY($2::text[])
      AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
    ORDER BY CASE cis.impact_level WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 WHEN 'P2' THEN 3 ELSE 4 END
    LIMIT 1
  `, [clusterId, PRIORITY_LEVELS]);

  const row = rows[0];
  if (!row) {
    const error = new Error('Cluster briefing not found');
    error.statusCode = 404;
    throw error;
  }
  if (isBriefingExcluded(row.category_slug, row.impact_level)) {
    const error = new Error('Cluster briefing excluded');
    error.statusCode = 404;
    throw error;
  }

  const storyHash = row.story_hash || storyHashFromParts({ links: row.links || [], title: row.title });
  const result = await pool.query(`
    INSERT INTO news_swipes (
      cluster_id,
      story_hash,
      action,
      locale,
      briefing_type,
      category_slug,
      impact_level,
      impact_score,
      impact_category,
      title,
      summary,
      links,
      latest_published_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW())
    ON CONFLICT (story_hash, locale) DO UPDATE SET
      cluster_id = EXCLUDED.cluster_id,
      action = EXCLUDED.action,
      briefing_type = EXCLUDED.briefing_type,
      category_slug = EXCLUDED.category_slug,
      impact_level = EXCLUDED.impact_level,
      impact_score = EXCLUDED.impact_score,
      impact_category = EXCLUDED.impact_category,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      links = EXCLUDED.links,
      latest_published_at = EXCLUDED.latest_published_at,
      swiped_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `, [
    row.cluster_id,
    storyHash,
    action,
    row.locale,
    row.briefing_type,
    row.category_slug,
    row.impact_level,
    row.impact_score,
    row.impact_category,
    row.title,
    row.summary,
    JSON.stringify(row.links || []),
    row.latest_published_at,
  ]);

  return result.rows[0];
}

export async function buildInterestedNews({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pool.query(`
    SELECT *
    FROM news_swipes
    WHERE action = 'interested'
    ORDER BY swiped_at DESC
    LIMIT $1
  `, [safeLimit]);
  return rows;
}
