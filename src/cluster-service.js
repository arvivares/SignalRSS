import { pool } from './db.js';

export async function buildClusters({ category = null, limit = 50 } = {}) {
  const params = [];
  let categoryFilter = '';

  if (category) {
    params.push(category);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.summary,
      sc.article_count,
      sc.first_published_at,
      sc.latest_published_at,
      tc.slug AS category_slug,
      tc.name AS category_name,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      cis.summary AS impact_summary,
      cis.why_it_matters,
      cis.impact_reasons,
      avg(ca.similarity)::float AS avg_similarity,
      min(ca.similarity)::float AS min_similarity,
      count(DISTINCT a.source_host)::int AS source_count,
      json_agg(
        json_build_object(
          'title', a.title,
          'url', a.canonical_url,
          'published_at', a.published_at,
          'similarity', ca.similarity,
          'role', ca.role,
          'source', a.source_host
        )
        ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
      ) AS articles
    FROM story_clusters sc
    LEFT JOIN topic_categories tc ON tc.id = sc.category_id
    LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
      ${categoryFilter}
    GROUP BY sc.id, tc.slug, tc.name, cis.cluster_id
    ORDER BY sc.latest_published_at DESC NULLS LAST, sc.updated_at DESC
    LIMIT ${limitParam}
  `, params);

  return rows;
}

export async function buildImpactClusters({
  category = 'artificial-intelligence',
  level = null,
  hours = 24,
  limit = 50,
} = {}) {
  const params = [hours];
  let categoryFilter = '';
  let levelFilter = '';

  if (category) {
    params.push(category);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  if (level) {
    params.push(level);
    levelFilter = `AND cis.impact_level = $${params.length}`;
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.article_count,
      sc.first_published_at,
      sc.latest_published_at,
      tc.slug AS category_slug,
      tc.name AS category_name,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      cis.summary AS impact_summary,
      cis.why_it_matters,
      cis.impact_reasons,
      cis.scored_at,
      avg(ca.similarity)::float AS avg_similarity,
      min(ca.similarity)::float AS min_similarity,
      count(DISTINCT a.source_host)::int AS source_count,
      json_agg(
        json_build_object(
          'title', a.title,
          'url', a.canonical_url,
          'published_at', a.published_at,
          'summary', a.summary,
          'similarity', ca.similarity,
          'role', ca.role,
          'source', a.source_host
        )
        ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
      ) AS articles
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    WHERE sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
      ${categoryFilter}
      ${levelFilter}
    GROUP BY sc.id, tc.slug, tc.name, cis.cluster_id
    ORDER BY
      CASE cis.impact_level
        WHEN 'P0' THEN 1
        WHEN 'P1' THEN 2
        WHEN 'P2' THEN 3
        ELSE 4
      END,
      cis.impact_score DESC,
      sc.latest_published_at DESC NULLS LAST
    LIMIT ${limitParam}
  `, params);

  return rows;
}

export async function buildClusterDetail(id) {
  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.summary,
      sc.article_count,
      sc.first_published_at,
      sc.latest_published_at,
      tc.slug AS category_slug,
      tc.name AS category_name,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      cis.summary AS impact_summary,
      cis.why_it_matters,
      cis.impact_reasons,
      avg(ca.similarity)::float AS avg_similarity,
      min(ca.similarity)::float AS min_similarity,
      count(DISTINCT a.source_host)::int AS source_count,
      json_agg(
        json_build_object(
          'title', a.title,
          'url', a.canonical_url,
          'published_at', a.published_at,
          'summary', a.summary,
          'similarity', ca.similarity,
          'role', ca.role,
          'source', a.source_host
        )
        ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
      ) AS articles
    FROM story_clusters sc
    LEFT JOIN topic_categories tc ON tc.id = sc.category_id
    LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    WHERE sc.id = $1
    GROUP BY sc.id, tc.slug, tc.name, cis.cluster_id
    LIMIT 1
  `, [id]);

  return rows[0] || null;
}
