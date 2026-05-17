ALTER TABLE mattermost_notifications
  ADD COLUMN IF NOT EXISTS input_hash TEXT;

UPDATE mattermost_notifications mn
SET input_hash = cb.input_hash
FROM cluster_briefings cb
WHERE mn.cluster_id = cb.cluster_id
  AND mn.locale = cb.locale
  AND mn.briefing_type = cb.briefing_type
  AND mn.input_hash IS NULL;

ALTER TABLE mattermost_notifications
  ALTER COLUMN input_hash SET NOT NULL;

ALTER TABLE mattermost_notifications
  DROP CONSTRAINT IF EXISTS mattermost_notifications_cluster_id_locale_briefing_type_destination_hash_key;

ALTER TABLE mattermost_notifications
  ADD CONSTRAINT mattermost_notifications_cluster_locale_type_hash_destination_key
  UNIQUE (cluster_id, locale, briefing_type, input_hash, destination_hash);
