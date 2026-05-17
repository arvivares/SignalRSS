CREATE INDEX IF NOT EXISTS idx_story_clusters_category_model_latest
  ON story_clusters (category_id, embedding_model, latest_published_at DESC);
