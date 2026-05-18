import { config } from './config.js';
import { pool } from './db.js';
import { filterBriefingRows } from './briefing-exclusions.js';
import { configuredLlmModelPolicies } from './llm-provider-policy.js';
import { impactEligibilitySql } from './impact-eligibility.js';

export async function buildFeedStats() {
  const [{ rows: totals }, { rows: countries }, { rows: articles }] = await Promise.all([
    pool.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled FROM feeds'),
    pool.query('SELECT country, count(*)::int AS total FROM feeds GROUP BY country ORDER BY country'),
    pool.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE published_at >= NOW() - INTERVAL '7 days'
            AND published_at <= NOW()
        )::int AS last_7_days
      FROM articles
    `),
  ]);

  return {
    total: totals[0]?.total || 0,
    enabled: totals[0]?.enabled || 0,
    articles: articles[0] || { total: 0, last_7_days: 0 },
    countries,
  };
}

export async function buildDashboardMetrics() {
  const [
    { rows: articleRows },
    { rows: feedRows },
    { rows: countryRows },
    { rows: topFeedRows },
    { rows: hourlyRows },
    { rows: backlogRows },
    { rows: briefingRows },
    { rows: mattermostRows },
    { rows: llmRows },
    { rows: briefingThroughputRows },
    { rows: claimRows },
    { rows: newsSwipeSummaryRows },
    { rows: newsSwipeRecentRows },
    { rows: workerActivityRows },
  ] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours')::int AS articles_published_24h,
        count(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '24 hours')::int AS articles_ingested_24h,
        count(*) FILTER (WHERE published_at >= NOW() - INTERVAL '7 days')::int AS articles_published_7d,
        count(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '7 days')::int AS articles_ingested_7d
      FROM articles
    `),
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM feeds WHERE enabled) AS enabled_feeds,
        (SELECT count(*)::int FROM feeds WHERE enabled AND last_success_at >= NOW() - INTERVAL '24 hours') AS successful_feeds_24h,
        (
          SELECT count(DISTINCT fe.feed_id)::int
          FROM feed_entries fe
          JOIN articles a ON a.id = fe.article_id
          WHERE a.first_seen_at >= NOW() - INTERVAL '24 hours'
        ) AS feeds_with_new_articles_24h,
        round((
          SELECT count(*)::numeric
          FROM articles
          WHERE first_seen_at >= NOW() - INTERVAL '24 hours'
        ) / 24, 1)::float AS avg_articles_ingested_per_hour
    `),
    pool.query(`
      SELECT
        f.country,
        count(DISTINCT fe.article_id)::int AS ingested_articles_24h,
        count(DISTINCT fe.feed_id)::int AS active_feeds_24h
      FROM feed_entries fe
      JOIN feeds f ON f.id = fe.feed_id
      JOIN articles a ON a.id = fe.article_id
      WHERE a.first_seen_at >= NOW() - INTERVAL '24 hours'
      GROUP BY f.country
      ORDER BY ingested_articles_24h DESC
    `),
    pool.query(`
      SELECT
        f.name,
        f.country,
        f.url,
        count(DISTINCT fe.article_id)::int AS ingested_articles_24h
      FROM feed_entries fe
      JOIN feeds f ON f.id = fe.feed_id
      JOIN articles a ON a.id = fe.article_id
      WHERE a.first_seen_at >= NOW() - INTERVAL '24 hours'
      GROUP BY f.id, f.name, f.country, f.url
      ORDER BY ingested_articles_24h DESC
      LIMIT 12
    `),
    pool.query(`
      SELECT
        date_trunc('hour', first_seen_at) AS hour_utc,
        count(*)::int AS articles_ingested
      FROM articles
      WHERE first_seen_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 1
    `),
    pool.query(`
      WITH recent_clusters AS (
        SELECT sc.id, sc.category_id, sc.updated_at
        FROM story_clusters sc
        WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
          AND ($1::timestamptz IS NULL OR sc.latest_published_at >= $1::timestamptz)
          AND EXISTS (
            SELECT 1
            FROM cluster_articles ca
            WHERE ca.cluster_id = sc.id
          )
      ),
      impact_jobs AS (
        SELECT
          tc.slug AS category,
          count(*) FILTER (WHERE j.status IN ('pending', 'running'))::int AS impact_pending,
          count(*) FILTER (WHERE j.status = 'running')::int AS impact_running,
          count(*) FILTER (
            WHERE j.status = 'running'
              AND (
                j.locked_at IS NULL
                OR j.locked_at < NOW() - ($2::int * INTERVAL '1 minute')
              )
          )::int AS impact_running_stale,
          count(*) FILTER (WHERE j.status = 'failed')::int AS impact_failed,
          min(sc.latest_published_at) FILTER (WHERE j.status IN ('pending', 'running')) AS oldest_pending_latest_published_at,
          max(sc.latest_published_at) FILTER (WHERE j.status IN ('pending', 'running')) AS newest_pending_latest_published_at
        FROM cluster_impact_jobs j
        JOIN story_clusters sc ON sc.id = j.cluster_id
        JOIN topic_categories tc ON tc.id = sc.category_id
        WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
          AND ($1::timestamptz IS NULL OR sc.latest_published_at >= $1::timestamptz)
          ${impactEligibilitySql({
            windowDefaultParam: 3,
            windowMapParam: 4,
            maxAgeMapParam: 5,
            maxAgeDefaultParam: 6,
          })}
        GROUP BY tc.slug
      )
      SELECT
        tc.slug AS category,
        count(rc.id)::int AS clusters,
        coalesce(ij.impact_pending, 0)::int AS impact_pending,
        coalesce(ij.impact_running, 0)::int AS impact_running,
        coalesce(ij.impact_failed, 0)::int AS impact_failed,
        ij.oldest_pending_latest_published_at,
        ij.newest_pending_latest_published_at,
        count(rc.id) FILTER (
          WHERE cis.cluster_id IS NOT NULL
            AND (
              cb.cluster_id IS NULL
              OR cb.updated_at < rc.updated_at
              OR cb.updated_at < cis.updated_at
            )
        )::int AS briefing_pending
      FROM recent_clusters rc
      JOIN topic_categories tc ON tc.id = rc.category_id
      LEFT JOIN impact_jobs ij ON ij.category = tc.slug
      LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = rc.id
      LEFT JOIN cluster_briefings cb
        ON cb.cluster_id = rc.id
        AND cb.locale = 'es'
        AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
      GROUP BY
        tc.slug,
        ij.impact_pending,
        ij.impact_running,
        ij.impact_failed,
        ij.oldest_pending_latest_published_at,
        ij.newest_pending_latest_published_at
      ORDER BY briefing_pending DESC, impact_pending DESC, tc.slug
    `, [
      config.impactMinPublishedAt || config.briefingMinPublishedAt || null,
      config.impactJobStaleMinutes,
      config.impactWindowHours,
      JSON.stringify(config.impactWindowHoursByCategory || {}),
      JSON.stringify(config.impactMaxClusterAgeHoursByCategory || {}),
      config.impactMaxClusterAgeHours,
    ]),
    pool.query(`
      SELECT
        tc.slug AS category,
        cis.impact_level,
        count(*) FILTER (
          WHERE cb.cluster_id IS NULL
             OR cb.updated_at < sc.updated_at
             OR cb.updated_at < cis.updated_at
        )::int AS briefing_pending
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      LEFT JOIN cluster_briefings cb
        ON cb.cluster_id = sc.id
        AND cb.locale = 'es'
        AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
      WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
        AND ($1::timestamptz IS NULL OR sc.latest_published_at >= $1::timestamptz)
        AND EXISTS (
          SELECT 1
          FROM cluster_articles ca
          WHERE ca.cluster_id = sc.id
        )
      GROUP BY tc.slug, cis.impact_level
      HAVING count(*) FILTER (
        WHERE cb.cluster_id IS NULL
           OR cb.updated_at < sc.updated_at
           OR cb.updated_at < cis.updated_at
      ) > 0
      ORDER BY briefing_pending DESC, tc.slug, cis.impact_level
    `, [config.briefingMinPublishedAt || null]),
    pool.query(`
      WITH configured_categories AS (
        SELECT unnest($1::text[]) AS category
      ),
      notification_counts AS (
        SELECT
          tc.slug AS category,
          mn.status,
          count(*)::int AS notifications,
          count(*) FILTER (WHERE mn.response_status IS NOT NULL AND mn.response_status <> 200)::int AS non_200
        FROM mattermost_notifications mn
        JOIN story_clusters sc ON sc.id = mn.cluster_id
        JOIN topic_categories tc ON tc.id = sc.category_id
        JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
        JOIN configured_categories cc ON cc.category = tc.slug
        WHERE cis.impact_level = 'P0'
        GROUP BY tc.slug, mn.status
      )
      SELECT
        cc.category,
        coalesce(nc.status, 'no_posts') AS status,
        coalesce(nc.notifications, 0)::int AS notifications,
        coalesce(nc.non_200, 0)::int AS non_200
      FROM configured_categories cc
      LEFT JOIN notification_counts nc ON nc.category = cc.category
      ORDER BY cc.category, coalesce(nc.status, 'no_posts')
    `, [config.mattermostCategorySlugs]),
    pool.query(`
      SELECT
        operation,
        provider,
        coalesce((metadata->>'impact_level'), '-') AS impact_level,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status = 'ok')::int AS ok,
        count(*) FILTER (WHERE status <> 'ok')::int AS failed,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_usd), 0)::float AS cost_usd
      FROM llm_request_logs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY operation, provider, coalesce((metadata->>'impact_level'), '-')
      ORDER BY operation, impact_level, provider
    `),
    pool.query(`
      SELECT
        tc.slug AS category,
        upper(split_part(cb.briefing_type, '-', 1)) AS impact_level,
        count(*) FILTER (WHERE cb.updated_at >= NOW() - INTERVAL '1 hour')::int AS generated_1h,
        count(*) FILTER (WHERE cb.updated_at >= NOW() - INTERVAL '24 hours')::int AS generated_24h
      FROM cluster_briefings cb
      JOIN story_clusters sc ON sc.id = cb.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      WHERE cb.briefing_type LIKE 'p%-cluster-briefing'
      GROUP BY tc.slug, upper(split_part(cb.briefing_type, '-', 1))
      HAVING count(*) FILTER (WHERE cb.updated_at >= NOW() - INTERVAL '24 hours') > 0
      ORDER BY generated_1h DESC, generated_24h DESC, tc.slug, impact_level
      LIMIT 20
    `),
    pool.query(`
      SELECT
        briefing_type,
        count(*)::int AS claims,
        count(*) FILTER (
          WHERE locked_at < NOW() - ($1::int * INTERVAL '1 minute')
        )::int AS stale_claims,
        min(locked_at) AS oldest_locked_at
      FROM cluster_briefing_claims
      GROUP BY briefing_type
      ORDER BY claims DESC, briefing_type
    `, [config.briefingClaimStaleMinutes]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT
        action,
        coalesce(impact_level, '-') AS impact_level,
        count(*)::int AS total
      FROM news_swipes
      GROUP BY action, coalesce(impact_level, '-')
      ORDER BY action, impact_level
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT
        action,
        impact_level,
        category_slug,
        title,
        summary,
        links,
        latest_published_at,
        swiped_at
      FROM news_swipes
      ORDER BY swiped_at DESC
      LIMIT 16
    `).catch(() => ({ rows: [] })),
    pool.query(`
      WITH latest_fetch AS (
        SELECT
          'ingest' AS component,
          'feeds' AS category,
          fr.status,
          coalesce(fr.finished_at, fr.started_at) AS last_activity_at,
          concat(fr.items_found, ' found / ', fr.items_inserted, ' inserted') AS detail
        FROM fetch_runs fr
        ORDER BY coalesce(fr.finished_at, fr.started_at) DESC
        LIMIT 1
      ),
      latest_classification AS (
        SELECT
          'classification' AS component,
          'all' AS category,
          cr.status,
          coalesce(cr.finished_at, cr.started_at) AS last_activity_at,
          concat(cr.articles_classified, '/', cr.articles_considered, ' articles') AS detail
        FROM classification_runs cr
        ORDER BY coalesce(cr.finished_at, cr.started_at) DESC
        LIMIT 1
      ),
      latest_clustering AS (
        SELECT
          'clustering' AS component,
          'all' AS category,
          cr.status,
          coalesce(cr.finished_at, cr.started_at) AS last_activity_at,
          concat(cr.articles_clustered, '/', cr.articles_considered, ' articles') AS detail
        FROM clustering_runs cr
        ORDER BY coalesce(cr.finished_at, cr.started_at) DESC
        LIMIT 1
      ),
      latest_impact AS (
        SELECT DISTINCT ON (coalesce(ir.category_slug, 'all'))
          'impact' AS component,
          coalesce(ir.category_slug, 'all') AS category,
          ir.status,
          coalesce(ir.finished_at, ir.started_at) AS last_activity_at,
          concat(ir.clusters_scored, '/', ir.clusters_considered, ' clusters') AS detail
        FROM impact_scoring_runs ir
        ORDER BY coalesce(ir.category_slug, 'all'), coalesce(ir.finished_at, ir.started_at) DESC
      ),
      latest_briefings AS (
        SELECT DISTINCT ON (tc.slug, split_part(cb.briefing_type, '-', 1))
          'briefing' AS component,
          tc.slug || ':' || upper(split_part(cb.briefing_type, '-', 1)) AS category,
          'generated' AS status,
          cb.updated_at AS last_activity_at,
          cb.model AS detail
        FROM cluster_briefings cb
        JOIN story_clusters sc ON sc.id = cb.cluster_id
        JOIN topic_categories tc ON tc.id = sc.category_id
        WHERE cb.updated_at >= NOW() - INTERVAL '24 hours'
        ORDER BY tc.slug, split_part(cb.briefing_type, '-', 1), cb.updated_at DESC
      ),
      latest_mattermost AS (
        SELECT DISTINCT ON (coalesce(tc.slug, 'unknown'), mn.status)
          'mattermost' AS component,
          coalesce(tc.slug, 'unknown') AS category,
          mn.status,
          mn.updated_at AS last_activity_at,
          coalesce(nullif(mn.error, ''), coalesce(mn.response_status::text, '')) AS detail
        FROM mattermost_notifications mn
        LEFT JOIN story_clusters sc ON sc.id = mn.cluster_id
        LEFT JOIN topic_categories tc ON tc.id = sc.category_id
        WHERE mn.updated_at >= NOW() - INTERVAL '24 hours'
        ORDER BY coalesce(tc.slug, 'unknown'), mn.status, mn.updated_at DESC
      )
      SELECT *
      FROM (
        SELECT * FROM latest_fetch
        UNION ALL SELECT * FROM latest_classification
        UNION ALL SELECT * FROM latest_clustering
        UNION ALL SELECT * FROM latest_impact
        UNION ALL SELECT * FROM latest_briefings
        UNION ALL SELECT * FROM latest_mattermost
      ) activity
      ORDER BY last_activity_at DESC NULLS LAST
      LIMIT 18
    `).catch(() => ({ rows: [] })),
  ]);

  const briefingPendingRows = filterBriefingRows(briefingRows);
  const briefingPendingByCategory = new Map();
  for (const row of briefingPendingRows) {
    briefingPendingByCategory.set(
      row.category,
      (briefingPendingByCategory.get(row.category) || 0) + Number(row.briefing_pending || 0),
    );
  }
  const adjustedBacklogRows = backlogRows.map((row) => ({
    ...row,
    briefing_pending: briefingPendingByCategory.get(row.category) || 0,
  }));

  const backlogTotals = adjustedBacklogRows.reduce((total, row) => ({
    impactPending: total.impactPending + Number(row.impact_pending || 0),
    impactRunning: total.impactRunning + Number(row.impact_running || 0),
    impactFailed: total.impactFailed + Number(row.impact_failed || 0),
    briefingPending: total.briefingPending + Number(row.briefing_pending || 0),
    completedCategories: total.completedCategories + (
      Number(row.impact_pending || 0) === 0
      && Number(row.impact_failed || 0) === 0
      && Number(row.briefing_pending || 0) === 0
        ? 1
        : 0
    ),
  }), {
    impactPending: 0,
    impactRunning: 0,
    impactFailed: 0,
    briefingPending: 0,
    completedCategories: 0,
  });

  return {
    articles: articleRows[0] || {},
    feeds: feedRows[0] || {},
    countries: countryRows,
    topFeeds: topFeedRows,
    hourly: hourlyRows,
    backlog: adjustedBacklogRows,
    briefingPending: briefingPendingRows,
    mattermost: mattermostRows.map((row) => ({
      ...row,
      channel: config.mattermostChannelsByCategory[row.category] || config.mattermostChannel || '',
    })),
    mattermostCategories: config.mattermostCategorySlugs.map((category) => ({
      category,
      channel: config.mattermostChannelsByCategory[category] || config.mattermostChannel || '',
    })),
    llm: llmRows,
    briefingThroughput: briefingThroughputRows,
    briefingClaims: claimRows,
    newsSwipes: {
      summary: newsSwipeSummaryRows,
      recent: newsSwipeRecentRows,
    },
    workerActivity: workerActivityRows,
    backlogTotals,
    refreshedAt: new Date(),
  };
}

export async function buildCategoryStats() {
  const { rows } = await pool.query(`
    SELECT
      tc.slug,
      tc.name,
      tc.description,
      count(ac.article_id)::int AS articles,
      avg(ac.confidence)::float AS avg_confidence
    FROM topic_categories tc
    LEFT JOIN article_classifications ac
      ON ac.category_id = tc.id
      AND ac.rank = 1
    WHERE tc.active = TRUE
    GROUP BY tc.id, tc.slug, tc.name, tc.description, tc.sort_order
    ORDER BY tc.sort_order ASC, tc.name ASC
  `);
  return rows;
}

export async function buildClassificationStats() {
  const [{ rows: totals }, { rows: runs }] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (
          WHERE a.published_at >= NOW() - INTERVAL '7 days'
            AND a.published_at <= NOW()
        )::int AS articles_last_7_days,
        count(*) FILTER (
          WHERE a.published_at >= NOW() - INTERVAL '7 days'
            AND a.published_at <= NOW()
            AND EXISTS (
              SELECT 1
              FROM article_classifications ac
              WHERE ac.article_id = a.id
                AND ac.model = $1
            )
        )::int AS classified_last_7_days,
        count(*) FILTER (
          WHERE a.published_at >= NOW() - INTERVAL '7 days'
            AND a.published_at <= NOW()
            AND NOT EXISTS (
              SELECT 1
              FROM article_classifications ac
              WHERE ac.article_id = a.id
                AND ac.model = $1
            )
        )::int AS pending_last_7_days
      FROM articles a
    `, [config.embeddingModel]),
    pool.query(`
      SELECT status, model, articles_considered, articles_classified, error, started_at, finished_at
      FROM classification_runs
      ORDER BY started_at DESC
      LIMIT 10
    `),
  ]);

  return {
    model: config.embeddingModel,
    ...totals[0],
    recent_runs: runs,
  };
}

export async function buildClusterStats() {
  const [{ rows: totals }, { rows: quality }, { rows: runs }] = await Promise.all([
    pool.query(`
      SELECT
        count(*)::int AS clusters_total,
        count(*) FILTER (
          WHERE latest_published_at >= NOW() - INTERVAL '7 days'
        )::int AS clusters_last_7_days,
        coalesce(sum(article_count), 0)::int AS clustered_article_links,
        coalesce(round(avg(article_count)::numeric, 2), 0)::float AS avg_cluster_size,
        coalesce(max(article_count), 0)::int AS max_cluster_size
      FROM story_clusters
    `),
    pool.query(`
      SELECT
        count(*) FILTER (WHERE article_count = 1)::int AS singleton_clusters,
        count(*) FILTER (WHERE article_count BETWEEN 2 AND 4)::int AS small_clusters,
        count(*) FILTER (WHERE article_count BETWEEN 5 AND 14)::int AS medium_clusters,
        count(*) FILTER (WHERE article_count >= 15)::int AS large_clusters,
        coalesce(avg(cluster_quality.avg_similarity), 0)::float AS avg_similarity,
        coalesce(avg(cluster_quality.min_similarity), 0)::float AS avg_min_similarity,
        coalesce(avg(cluster_quality.source_count), 0)::float AS avg_source_count
      FROM story_clusters sc
      LEFT JOIN (
        SELECT
          ca.cluster_id,
          avg(ca.similarity)::float AS avg_similarity,
          min(ca.similarity)::float AS min_similarity,
          count(DISTINCT a.source_host)::float AS source_count
        FROM cluster_articles ca
        JOIN articles a ON a.id = ca.article_id
        GROUP BY ca.cluster_id
      ) cluster_quality ON cluster_quality.cluster_id = sc.id
    `),
    pool.query(`
      SELECT status, model, similarity_threshold, articles_considered, articles_clustered,
             clusters_created, error, started_at, finished_at
      FROM clustering_runs
      ORDER BY started_at DESC
      LIMIT 10
    `),
  ]);

  return {
    model: config.embeddingModel,
    similarity_threshold: config.clusterSimilarityThreshold,
    category_thresholds: {
      'artificial-intelligence': config.clusterAiSimilarityThreshold,
    },
    ...totals[0],
    quality: quality[0],
    recent_runs: runs,
  };
}

export async function buildImpactStats({ category = 'artificial-intelligence', hours = 24 } = {}) {
  const params = [hours];
  let categoryFilter = '';

  if (category) {
    params.push(category);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const [{ rows: totals }, { rows: runs }] = await Promise.all([
    pool.query(`
      SELECT
        count(sc.id)::int AS clusters_in_window,
        count(cis.cluster_id)::int AS scored_clusters,
        count(sc.id)::int - count(cis.cluster_id)::int AS pending_clusters,
        count(cis.cluster_id) FILTER (WHERE cis.impact_level = 'P0')::int AS p0,
        count(cis.cluster_id) FILTER (WHERE cis.impact_level = 'P1')::int AS p1,
        count(cis.cluster_id) FILTER (WHERE cis.impact_level = 'P2')::int AS p2,
        count(cis.cluster_id) FILTER (WHERE cis.impact_level = 'P3')::int AS p3,
        coalesce(round(avg(cis.impact_score)::numeric, 2), 0)::float AS avg_impact_score
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND sc.latest_published_at <= NOW()
        ${categoryFilter}
    `, params),
    pool.query(`
      SELECT status, model, category_slug, clusters_considered, clusters_scored, error, started_at, finished_at
      FROM impact_scoring_runs
      ORDER BY started_at DESC
      LIMIT 10
    `),
  ]);

  return {
    model: config.impactModel,
    category,
    hours,
    ...totals[0],
    recent_runs: runs,
  };
}

function policyKey(row) {
  return `${row.provider}:${row.model}:${row.operation}`;
}

export function splitCooldownRows(cooldownRows = [], policies = []) {
  const configured = new Map(policies.map((policy) => [policyKey(policy), policy]));
  const enabled = new Set(policies.filter((policy) => policy.enabled).map(policyKey));
  const active = [];
  const inactiveHistorical = [];

  for (const row of cooldownRows) {
    const key = policyKey(row);
    if (enabled.has(key)) {
      active.push(row);
    } else {
      inactiveHistorical.push({
        ...row,
        configured: configured.has(key),
        enabled: false,
      });
    }
  }

  return {
    active,
    inactiveHistorical,
  };
}

export function splitProviderRows(providerRows = [], policies = []) {
  const configured = new Map(policies.map((policy) => [policyKey({
    provider: policy.provider,
    model: policy.model,
    operation: policy.operation,
  }), policy]));

  return providerRows.map((row) => {
    const key = policyKey({
      provider: row.provider,
      model: row.requested_model,
      operation: row.operation,
    });
    const policy = configured.get(key);
    return {
      ...row,
      configured: Boolean(policy),
      enabled: Boolean(policy?.enabled),
    };
  });
}

function healthStatus({
  impactPending,
  impactFailed,
  staleImpactRunning,
  briefingPending,
  staleBriefingClaims,
  mattermostFailed,
  activeCooldowns,
}) {
  if (impactFailed > 0 || staleImpactRunning > 0 || staleBriefingClaims > 0) return 'degraded';
  if (impactPending > 250 || briefingPending > 250 || mattermostFailed > 25) return 'degraded';
  if (activeCooldowns > 10) return 'warning';
  return 'ok';
}

export async function buildOpsHealth() {
  const [
    { rows: impactRows },
    { rows: briefingRows },
    { rows: staleBriefingClaimRows },
    { rows: cooldownRows },
    { rows: providerRows },
    { rows: dbRows },
    { rows: mattermostRows },
    { rows: feedRows },
  ] = await Promise.all([
    pool.query(`
      SELECT
        tc.slug AS category,
        j.status,
        count(*)::int AS jobs,
        count(*) FILTER (
          WHERE j.status = 'running'
            AND j.locked_at >= NOW() - ($1::int * INTERVAL '1 minute')
        )::int AS running_fresh,
        count(*) FILTER (
          WHERE j.status = 'running'
            AND (
              j.locked_at IS NULL
              OR j.locked_at < NOW() - ($1::int * INTERVAL '1 minute')
            )
        )::int AS running_stale,
        count(*) FILTER (
          WHERE j.status = 'failed'
            AND j.attempts < $2
        )::int AS failed_retryable,
        count(*) FILTER (
          WHERE j.status = 'failed'
            AND j.attempts >= $2
        )::int AS failed_final,
        min(j.updated_at) AS oldest_updated_at,
        min(sc.latest_published_at) AS oldest_latest_published_at,
        max(sc.latest_published_at) AS newest_latest_published_at
      FROM cluster_impact_jobs j
      JOIN story_clusters sc ON sc.id = j.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      WHERE ($7::timestamptz IS NULL OR sc.latest_published_at >= $7::timestamptz)
        ${impactEligibilitySql({
          windowDefaultParam: 3,
          windowMapParam: 4,
          maxAgeMapParam: 5,
          maxAgeDefaultParam: 6,
        })}
      GROUP BY tc.slug, j.status
      ORDER BY tc.slug, j.status
    `, [
      config.impactJobStaleMinutes,
      config.impactJobMaxAttempts,
      config.impactWindowHours,
      JSON.stringify(config.impactWindowHoursByCategory || {}),
      JSON.stringify(config.impactMaxClusterAgeHoursByCategory || {}),
      config.impactMaxClusterAgeHours,
      config.impactMinPublishedAt || null,
    ]),
    pool.query(`
      SELECT
        tc.slug AS category,
        cis.impact_level,
        count(*) FILTER (
          WHERE cb.cluster_id IS NULL
             OR cb.updated_at < sc.updated_at
             OR cb.updated_at < cis.updated_at
        )::int AS pending
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      LEFT JOIN cluster_briefings cb
        ON cb.cluster_id = sc.id
        AND cb.locale = 'es'
        AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
      WHERE sc.latest_published_at >= NOW() - INTERVAL '7 days'
        AND ($1::timestamptz IS NULL OR sc.latest_published_at >= $1::timestamptz)
      GROUP BY tc.slug, cis.impact_level
      HAVING count(*) FILTER (
        WHERE cb.cluster_id IS NULL
           OR cb.updated_at < sc.updated_at
           OR cb.updated_at < cis.updated_at
      ) > 0
      ORDER BY pending DESC, tc.slug, cis.impact_level
    `, [config.briefingMinPublishedAt || null]),
    pool.query(`
      SELECT
        briefing_type,
        count(*)::int AS claims,
        count(*) FILTER (
          WHERE locked_at < NOW() - ($1::int * INTERVAL '1 minute')
        )::int AS stale_claims,
        min(locked_at) AS oldest_locked_at
      FROM cluster_briefing_claims
      GROUP BY briefing_type
      ORDER BY claims DESC, briefing_type
    `, [config.briefingClaimStaleMinutes]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT provider, model, operation, reason, cooldown_until, failure_count, last_error
      FROM llm_provider_cooldowns
      WHERE cooldown_until > NOW()
      ORDER BY cooldown_until DESC
      LIMIT 30
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT
        operation,
        provider,
        requested_model,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status = 'ok')::int AS ok,
        count(*) FILTER (WHERE status <> 'ok')::int AS failed,
        round(avg(latency_ms))::int AS avg_latency_ms
      FROM llm_request_logs
      WHERE created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY operation, provider, requested_model
      ORDER BY failed DESC, requests DESC
      LIMIT 40
    `),
    pool.query(`
      SELECT
        relname AS table_name,
        n_live_tup::bigint AS live_rows,
        n_dead_tup::bigint AS dead_rows,
        CASE
          WHEN n_live_tup > 0 THEN round((n_dead_tup::numeric / n_live_tup::numeric) * 100, 2)
          ELSE 0
        END::float AS dead_row_pct,
        pg_total_relation_size(relid)::bigint AS total_bytes,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_dead_tup DESC, pg_total_relation_size(relid) DESC
      LIMIT 15
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT
        status,
        coalesce(error, '') AS error,
        count(*)::int AS notifications,
        max(updated_at) AS last_updated_at
      FROM mattermost_notifications
      WHERE updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY status, coalesce(error, '')
      ORDER BY notifications DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT
        count(*) FILTER (WHERE enabled)::int AS enabled,
        count(*) FILTER (WHERE enabled AND last_success_at >= NOW() - INTERVAL '24 hours')::int AS successful_24h,
        count(*) FILTER (WHERE enabled AND last_error IS NOT NULL AND last_success_at < NOW() - INTERVAL '24 hours')::int AS stale_or_failing
      FROM feeds
    `),
  ]);

  const briefingPendingRows = filterBriefingRows(briefingRows);
  const impactTotals = impactRows.reduce((totals, row) => {
    totals[row.status] = (totals[row.status] || 0) + Number(row.jobs || 0);
    totals.running_fresh = (totals.running_fresh || 0) + Number(row.running_fresh || 0);
    totals.running_stale = (totals.running_stale || 0) + Number(row.running_stale || 0);
    totals.failed_retryable = (totals.failed_retryable || 0) + Number(row.failed_retryable || 0);
    totals.failed_final = (totals.failed_final || 0) + Number(row.failed_final || 0);
    return totals;
  }, {});
  const briefingPending = briefingPendingRows.reduce((total, row) => total + Number(row.pending || 0), 0);
  const staleBriefingClaims = staleBriefingClaimRows.reduce((total, row) => total + Number(row.stale_claims || 0), 0);
  const mattermostFailed = mattermostRows
    .filter((row) => row.status === 'failed')
    .reduce((total, row) => total + Number(row.notifications || 0), 0);
  const policies = [
    ...configuredLlmModelPolicies('impact_scoring'),
    ...configuredLlmModelPolicies('briefing_generation'),
  ];
  const cooldowns = splitCooldownRows(cooldownRows, policies);
  const providerActivity = splitProviderRows(providerRows, policies);
  const status = healthStatus({
    impactPending: Number(impactTotals.pending || 0),
    impactFailed: Number(impactTotals.failed || 0),
    staleImpactRunning: Number(impactTotals.running_stale || 0),
    briefingPending,
    staleBriefingClaims,
    mattermostFailed,
    activeCooldowns: cooldowns.active.length,
  });

  return {
    status,
    generatedAt: new Date(),
    queues: {
      impact: {
        totals: impactTotals,
        byCategory: impactRows,
      },
      briefing: {
        pending: briefingPending,
        byCategory: briefingPendingRows,
        claims: staleBriefingClaimRows,
      },
    },
    providers: {
      policies,
      activeCooldowns: cooldowns.active,
      inactiveHistoricalCooldowns: cooldowns.inactiveHistorical,
      lastHour: providerActivity,
    },
    database: {
      tables: dbRows,
      deadRows: dbRows.reduce((total, row) => total + Number(row.dead_rows || 0), 0),
      highestDeadRowPct: dbRows.reduce((max, row) => Math.max(max, Number(row.dead_row_pct || 0)), 0),
    },
    mattermost: mattermostRows,
    feeds: feedRows[0] || {},
  };
}
