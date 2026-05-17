ALTER TABLE mattermost_notifications
  ADD COLUMN IF NOT EXISTS story_hash TEXT;

UPDATE mattermost_notifications mn
SET story_hash = md5(
  COALESCE(
    (
      SELECT string_agg(lower(trim(link->>'url')), E'\n' ORDER BY lower(trim(link->>'url')))
      FROM jsonb_array_elements(COALESCE(mn.snapshot_links, '[]'::jsonb)) AS link
      WHERE COALESCE(trim(link->>'url'), '') <> ''
    ),
    lower(regexp_replace(COALESCE(mn.snapshot_title, ''), '\s+', ' ', 'g'))
  )
)
WHERE mn.story_hash IS NULL;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY story_hash, locale
      ORDER BY
        CASE status
          WHEN 'posted' THEN 1
          WHEN 'processing' THEN 2
          WHEN 'skipped_existing' THEN 3
          ELSE 4
        END,
        posted_at ASC NULLS LAST,
        created_at ASC
    ) AS rn
  FROM mattermost_notifications
  WHERE story_hash IS NOT NULL
    AND status IN ('processing', 'posted', 'skipped_existing')
)
UPDATE mattermost_notifications mn
SET status = 'skipped_duplicate',
    updated_at = NOW()
FROM ranked
WHERE ranked.id = mn.id
  AND ranked.rn > 1;

ALTER TABLE mattermost_notifications
  DROP CONSTRAINT IF EXISTS mattermost_notifications_cluster_id_fkey;

ALTER TABLE mattermost_notifications
  ALTER COLUMN cluster_id DROP NOT NULL;

ALTER TABLE mattermost_notifications
  ADD CONSTRAINT mattermost_notifications_cluster_id_fkey
  FOREIGN KEY (cluster_id) REFERENCES story_clusters(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mattermost_notifications_active_story_hash
  ON mattermost_notifications (story_hash, locale)
  WHERE story_hash IS NOT NULL
    AND status IN ('processing', 'posted', 'skipped_existing');

CREATE INDEX IF NOT EXISTS idx_mattermost_notifications_story_hash
  ON mattermost_notifications (story_hash, status, posted_at DESC)
  WHERE story_hash IS NOT NULL;
