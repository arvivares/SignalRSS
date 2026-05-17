import { config } from './config.js';
import { pool } from './db.js';

export const briefingConfigs = {
  P0: {
    level: 'P0',
    type: 'p0-cluster-briefing',
    defaultHours: () => config.p0BriefingWindowHours,
    path: 'p0',
  },
  P1: {
    level: 'P1',
    type: 'p1-cluster-briefing',
    defaultHours: () => config.p1BriefingWindowHours,
    path: 'p1',
  },
  P2: {
    level: 'P2',
    type: 'p2-cluster-briefing',
    defaultHours: () => config.p2BriefingWindowHours,
    path: 'p2',
  },
  P3: {
    level: 'P3',
    type: 'p3-cluster-briefing',
    defaultHours: () => config.p3BriefingWindowHours,
    path: 'p3',
  },
};

export async function buildBriefings({
  level = 'P0',
  category = 'artificial-intelligence',
  hours = briefingConfigs[level].defaultHours(),
  limit = 50,
  page = 1,
} = {}) {
  const briefingConfig = briefingConfigs[level];
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.max(Number(limit) || 50, 1);
  const countResult = await pool.query(`
    SELECT count(*)::int AS total
    FROM cluster_briefings cb
    JOIN story_clusters sc ON sc.id = cb.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cb.locale = 'es'
      AND cb.briefing_type = $2
      AND cis.impact_level = $3
      AND tc.slug = $4
      AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
  `, [hours, briefingConfig.type, briefingConfig.level, category]);
  const total = countResult.rows[0]?.total || 0;
  const pages = Math.max(Math.ceil(total / safeLimit), 1);
  const currentPage = Math.min(safePage, pages);
  const offset = (currentPage - 1) * safeLimit;

  const { rows } = await pool.query(`
    SELECT
      cb.cluster_id,
      cb.title,
      cb.summary,
      cb.links,
      cb.payload,
      cb.generated_at,
      sc.latest_published_at,
      cis.impact_score,
      cis.impact_category,
      tc.slug AS category_slug,
      tc.name AS category_name
    FROM cluster_briefings cb
    JOIN story_clusters sc ON sc.id = cb.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cb.locale = 'es'
      AND cb.briefing_type = $3
      AND cis.impact_level = $4
      AND tc.slug = $6
      AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
    ORDER BY sc.latest_published_at DESC, cis.impact_score DESC, cb.generated_at DESC
    LIMIT $2
    OFFSET $5
  `, [hours, safeLimit, briefingConfig.type, briefingConfig.level, offset, category]);

  const items = rows.map((row) => ({
    cluster_id: row.cluster_id,
    title: row.title,
    summary: row.summary,
    links: row.links || [],
    impact_level: briefingConfig.level,
    impact_score: row.impact_score,
    impact_category: row.impact_category,
    category_slug: row.category_slug,
    category_name: row.category_name,
    latest_published_at: row.latest_published_at,
    generated_at: row.generated_at,
    payload: row.payload,
  }));

  return {
    items,
    total,
    page: currentPage,
    limit: safeLimit,
    pages,
  };
}

export async function buildBriefingDetail(clusterId, level = 'P0', category = 'artificial-intelligence') {
  const briefingConfig = briefingConfigs[level];
  const { rows } = await pool.query(`
    SELECT
      cb.cluster_id,
      cb.title,
      cb.summary,
      cb.links,
      cb.payload,
      cb.generated_at,
      sc.latest_published_at,
      cis.impact_score,
      cis.impact_category,
      tc.slug AS category_slug,
      tc.name AS category_name
    FROM cluster_briefings cb
    JOIN story_clusters sc ON sc.id = cb.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cb.cluster_id = $1
      AND cb.locale = 'es'
      AND cb.briefing_type = $2
      AND cis.impact_level = $3
      AND tc.slug = $4
    LIMIT 1
  `, [clusterId, briefingConfig.type, briefingConfig.level, category]);

  const row = rows[0];
  if (!row) return null;

  return {
    cluster_id: row.cluster_id,
    title: row.title,
    summary: row.summary,
    links: row.links || [],
    impact_level: briefingConfig.level,
    impact_score: row.impact_score,
    impact_category: row.impact_category,
    category_slug: row.category_slug,
    category_name: row.category_name,
    latest_published_at: row.latest_published_at,
    generated_at: row.generated_at,
    payload: row.payload,
  };
}
