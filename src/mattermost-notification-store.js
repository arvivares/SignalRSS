import { config } from './config.js';
import { pool } from './db.js';
import { briefingStoryHash } from './story-hash.js';
import { cleanText } from './text-utils.js';

const FINAL_STATUSES = ['posted', 'skipped_existing'];
const BLOCKING_STATUSES = FINAL_STATUSES;

function blockingStatusSql(alias = 'mn') {
  return `(
    ${alias}.status = ANY($4::text[])
    OR (
      ${alias}.status = 'processing'
      AND ${alias}.updated_at >= NOW() - ($8::int * INTERVAL '1 minute')
    )
  )`;
}

export async function markExistingBriefingsSkipped({ destination, levels }) {
  const { rows } = await pool.query(
    `
      SELECT count(*)::int AS count
      FROM mattermost_notifications mn
      JOIN story_clusters sc ON sc.id = mn.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      WHERE tc.slug = $1
        AND mn.status = ANY($2::text[])
    `,
    [destination.categorySlug, BLOCKING_STATUSES],
  );

  if (rows[0]?.count > 0) return 0;

  const { rowCount } = await pool.query(`
    INSERT INTO mattermost_notifications (
      cluster_id,
      locale,
      briefing_type,
      input_hash,
      story_hash,
      destination_hash,
      status,
      posted_at,
      snapshot_title,
      snapshot_summary,
      snapshot_links,
      snapshot_impact_level,
      snapshot_impact_score,
      snapshot_impact_category,
      snapshot_latest_published_at,
      snapshot_generated_at,
      updated_at
    )
    SELECT
      cb.cluster_id,
      cb.locale,
      cb.briefing_type,
      cb.input_hash,
      cb.story_hash,
      $2,
      'skipped_existing',
      NOW(),
      cb.title,
      cb.summary,
      cb.links,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      sc.latest_published_at,
      cb.generated_at,
      NOW()
    FROM cluster_briefings cb
    JOIN story_clusters sc ON sc.id = cb.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cb.locale = 'es'
      AND cis.impact_level = ANY($1::text[])
      AND NOT (cis.impact_level = 'P0' AND cis.evidence_confidence = 'low')
      AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
      AND tc.slug = $4
      AND sc.latest_published_at >= NOW() - ($3::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
    ON CONFLICT DO NOTHING
  `, [levels, destination.hash, config.mattermostWindowHours, destination.categorySlug]);

  return rowCount;
}

export async function loadPendingBriefings({ destination, levels }) {
  const { rows } = await pool.query(`
    WITH pending_briefings AS (
      SELECT
        cb.cluster_id,
        cb.locale,
        cb.briefing_type,
        cb.input_hash,
        cb.story_hash,
        cb.title,
        cb.summary,
        cb.links,
        cb.generated_at,
        sc.latest_published_at,
        tc.slug AS category_slug,
        cis.impact_level,
        cis.impact_score,
        cis.impact_category,
        cis.evidence_confidence,
        cis.evidence_quality_score
      FROM cluster_briefings cb
      JOIN story_clusters sc ON sc.id = cb.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE cb.locale = 'es'
        AND cis.impact_level = ANY($1::text[])
        AND NOT (cis.impact_level = 'P0' AND cis.evidence_confidence = 'low')
        AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
        AND tc.slug = $5
        AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 hour')
        AND sc.latest_published_at <= NOW()
        AND cb.generated_at <= NOW() - ($6::int * INTERVAL '1 minute')
    )
    SELECT *
    FROM pending_briefings cb
    WHERE NOT EXISTS (
        SELECT 1
        FROM mattermost_notifications mn
        WHERE mn.story_hash = cb.story_hash
          AND mn.locale = cb.locale
          AND ${blockingStatusSql('mn')}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM cross_category_cluster_adjudications cca
        JOIN mattermost_notifications mn
          ON mn.cluster_id = CASE
            WHEN cca.left_cluster_id = cb.cluster_id THEN cca.right_cluster_id
            ELSE cca.left_cluster_id
          END
        WHERE cca.decision = 'same_story'
          AND mn.locale = cb.locale
          AND ${blockingStatusSql('mn')}
          AND (
            cca.left_cluster_id = cb.cluster_id
            OR cca.right_cluster_id = cb.cluster_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM cross_category_cluster_adjudications cca
        WHERE cca.decision = 'same_story'
          AND cca.merged = false
          AND (
            cca.left_cluster_id = cb.cluster_id
            OR cca.right_cluster_id = cb.cluster_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM mattermost_notifications mn
        WHERE mn.cluster_id = cb.cluster_id
          AND mn.locale = cb.locale
          AND mn.briefing_type = cb.briefing_type
          AND ${blockingStatusSql('mn')}
          AND (
            mn.input_hash = cb.input_hash
            OR mn.destination_hash = $7
          )
      )
    ORDER BY
      CASE cb.impact_level
        WHEN 'P0' THEN 1
        WHEN 'P1' THEN 2
        WHEN 'P2' THEN 3
        ELSE 4
      END,
      cb.latest_published_at ASC,
      cb.generated_at ASC
    LIMIT $3
  `, [
    levels,
    config.mattermostWindowHours,
    config.mattermostBatchSize,
    BLOCKING_STATUSES,
    destination.categorySlug,
    config.mattermostStabilityDelayMinutes,
    destination.hash,
    config.mattermostProcessingStaleMinutes,
  ]);

  return rows;
}

export async function saveNotification({
  briefing,
  hash,
  status,
  responseStatus = null,
  responseBody = null,
  error = null,
  payload = null,
  thumbnailUrl = '',
}) {
  const storyHash = briefingStoryHash(briefing);
  await pool.query(`
    INSERT INTO mattermost_notifications (
      cluster_id,
      locale,
      briefing_type,
      input_hash,
      story_hash,
      destination_hash,
      status,
      response_status,
      response_body,
      error,
      posted_at,
      snapshot_title,
      snapshot_summary,
      snapshot_links,
      snapshot_payload,
      snapshot_thumbnail_url,
      snapshot_impact_level,
      snapshot_impact_score,
      snapshot_impact_category,
      snapshot_latest_published_at,
      snapshot_generated_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      CASE WHEN $7 = 'posted' THEN NOW() ELSE NULL END,
      $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, NOW()
    )
    ON CONFLICT (cluster_id, locale, briefing_type, input_hash, destination_hash) DO UPDATE SET
      story_hash = EXCLUDED.story_hash,
      status = EXCLUDED.status,
      response_status = EXCLUDED.response_status,
      response_body = EXCLUDED.response_body,
      error = EXCLUDED.error,
      posted_at = EXCLUDED.posted_at,
      snapshot_title = EXCLUDED.snapshot_title,
      snapshot_summary = EXCLUDED.snapshot_summary,
      snapshot_links = EXCLUDED.snapshot_links,
      snapshot_payload = EXCLUDED.snapshot_payload,
      snapshot_thumbnail_url = EXCLUDED.snapshot_thumbnail_url,
      snapshot_impact_level = EXCLUDED.snapshot_impact_level,
      snapshot_impact_score = EXCLUDED.snapshot_impact_score,
      snapshot_impact_category = EXCLUDED.snapshot_impact_category,
      snapshot_latest_published_at = EXCLUDED.snapshot_latest_published_at,
      snapshot_generated_at = EXCLUDED.snapshot_generated_at,
      updated_at = NOW()
  `, [
    briefing.cluster_id,
    briefing.locale,
    briefing.briefing_type,
    briefing.input_hash,
    storyHash,
    hash,
    status,
    responseStatus,
    responseBody,
    error,
    cleanText(briefing.title),
    cleanText(briefing.summary),
    JSON.stringify(briefing.links || []),
    payload ? JSON.stringify(payload) : null,
    thumbnailUrl || '',
    briefing.impact_level,
    briefing.impact_score,
    briefing.impact_category,
    briefing.latest_published_at,
    briefing.generated_at,
  ]);
}

function isPostedDestinationConflict(error) {
  return (
    error?.code === '23505'
    && (
      error?.constraint === 'idx_mattermost_notifications_posted_cluster_destination'
      || String(error?.message || '').includes('idx_mattermost_notifications_posted_cluster_destination')
    )
  );
}

function isActiveStoryHashConflict(error) {
  return (
    error?.code === '23505'
    && (
      error?.constraint === 'idx_mattermost_notifications_active_story_hash'
      || String(error?.message || '').includes('idx_mattermost_notifications_active_story_hash')
    )
  );
}

export async function savePostedNotification({ briefing, hash, result }) {
  try {
    await saveNotification({
      briefing,
      hash,
      status: 'posted',
      responseStatus: result.status,
      responseBody: result.body,
      payload: result.payload,
      thumbnailUrl: result.thumbnailUrl,
    });
    return 'posted';
  } catch (error) {
    if (!isPostedDestinationConflict(error) && !isActiveStoryHashConflict(error)) throw error;
    return 'skipped_existing';
  }
}

export async function claimNotification({ briefing, hash }) {
  try {
    const { rowCount } = await pool.query(`
      INSERT INTO mattermost_notifications (
        cluster_id,
        locale,
        briefing_type,
        input_hash,
        story_hash,
        destination_hash,
        status,
        snapshot_title,
        snapshot_summary,
        snapshot_links,
        snapshot_impact_level,
        snapshot_impact_score,
        snapshot_impact_category,
        snapshot_latest_published_at,
        snapshot_generated_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, $8, $9::jsonb, $10, $11, $12, $13, $14, NOW())
      ON CONFLICT (cluster_id, locale, briefing_type, input_hash, destination_hash) DO UPDATE SET
        story_hash = EXCLUDED.story_hash,
        status = 'processing',
        error = NULL,
        response_status = NULL,
        response_body = NULL,
        updated_at = NOW()
      WHERE (
          mattermost_notifications.status = 'failed'
          AND mattermost_notifications.updated_at < NOW() - ($16::int * INTERVAL '1 minute')
        )
        OR (
          mattermost_notifications.status = 'processing'
          AND mattermost_notifications.updated_at < NOW() - ($15::int * INTERVAL '1 minute')
        )
    `, [
      briefing.cluster_id,
      briefing.locale,
      briefing.briefing_type,
      briefing.input_hash,
      briefingStoryHash(briefing),
      hash,
      cleanText(briefing.title),
      cleanText(briefing.summary),
      JSON.stringify(briefing.links || []),
      briefing.impact_level,
      briefing.impact_score,
      briefing.impact_category,
      briefing.latest_published_at,
      briefing.generated_at,
      config.mattermostProcessingStaleMinutes,
      config.mattermostFailedRetryBackoffMinutes,
    ]);

    return rowCount > 0;
  } catch (error) {
    if (isActiveStoryHashConflict(error)) return false;
    throw error;
  }
}
