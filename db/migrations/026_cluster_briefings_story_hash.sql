ALTER TABLE cluster_briefings
  ADD COLUMN IF NOT EXISTS story_hash TEXT;

UPDATE cluster_briefings cb
SET story_hash = md5(
  COALESCE(
    (
      SELECT string_agg(lower(trim(link->>'url')), E'\n' ORDER BY lower(trim(link->>'url')))
      FROM jsonb_array_elements(COALESCE(cb.links, '[]'::jsonb)) AS link
      WHERE COALESCE(trim(link->>'url'), '') <> ''
    ),
    lower(regexp_replace(COALESCE(cb.title, ''), '\s+', ' ', 'g'))
  )
)
WHERE cb.story_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_cluster_briefings_story_hash
  ON cluster_briefings (story_hash, locale)
  WHERE story_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cluster_briefings_pending_lookup
  ON cluster_briefings (locale, briefing_type, generated_at DESC);
