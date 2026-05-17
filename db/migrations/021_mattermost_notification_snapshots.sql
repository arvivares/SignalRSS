ALTER TABLE mattermost_notifications
  ADD COLUMN IF NOT EXISTS snapshot_title TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_summary TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_links JSONB,
  ADD COLUMN IF NOT EXISTS snapshot_payload JSONB,
  ADD COLUMN IF NOT EXISTS snapshot_thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_impact_level TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_impact_score INTEGER,
  ADD COLUMN IF NOT EXISTS snapshot_impact_category TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_latest_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snapshot_generated_at TIMESTAMPTZ;

UPDATE mattermost_notifications mn
SET
  snapshot_title = COALESCE(mn.snapshot_title, cb.title),
  snapshot_summary = COALESCE(mn.snapshot_summary, cb.summary),
  snapshot_links = COALESCE(mn.snapshot_links, cb.links),
  snapshot_impact_level = COALESCE(mn.snapshot_impact_level, cis.impact_level),
  snapshot_impact_score = COALESCE(mn.snapshot_impact_score, cis.impact_score),
  snapshot_impact_category = COALESCE(mn.snapshot_impact_category, cis.impact_category),
  snapshot_latest_published_at = COALESCE(mn.snapshot_latest_published_at, sc.latest_published_at),
  snapshot_generated_at = COALESCE(mn.snapshot_generated_at, cb.generated_at)
FROM cluster_briefings cb
JOIN story_clusters sc ON sc.id = cb.cluster_id
JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
WHERE mn.cluster_id = cb.cluster_id
  AND mn.locale = cb.locale
  AND mn.briefing_type = cb.briefing_type;

WITH article_links AS (
  SELECT
    ca.cluster_id,
    jsonb_agg(
      jsonb_build_object(
        'title', a.title,
        'url', a.canonical_url,
        'source', a.source_host
      )
      ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
    ) FILTER (WHERE a.canonical_url IS NOT NULL AND a.canonical_url <> '') AS links
  FROM cluster_articles ca
  JOIN articles a ON a.id = ca.article_id
  GROUP BY ca.cluster_id
)
UPDATE mattermost_notifications mn
SET
  snapshot_title = COALESCE(mn.snapshot_title, sc.title),
  snapshot_links = COALESCE(mn.snapshot_links, article_links.links),
  snapshot_latest_published_at = COALESCE(mn.snapshot_latest_published_at, sc.latest_published_at)
FROM story_clusters sc
LEFT JOIN article_links ON article_links.cluster_id = sc.id
WHERE mn.cluster_id = sc.id;

CREATE INDEX IF NOT EXISTS idx_mattermost_notifications_snapshot_posted
  ON mattermost_notifications (status, posted_at DESC)
  WHERE status = 'posted';
