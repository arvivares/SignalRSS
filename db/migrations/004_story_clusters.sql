CREATE TABLE IF NOT EXISTS story_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  summary TEXT,
  category_id UUID REFERENCES topic_categories(id) ON DELETE SET NULL,
  representative_article_id UUID REFERENCES articles(id) ON DELETE SET NULL,
  centroid_embedding JSONB NOT NULL,
  embedding_model TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 1,
  first_published_at TIMESTAMPTZ,
  latest_published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cluster_articles (
  cluster_id UUID NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  similarity NUMERIC(7, 6) NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, article_id),
  UNIQUE (article_id)
);

CREATE TABLE IF NOT EXISTS clustering_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  similarity_threshold NUMERIC(7, 6) NOT NULL,
  articles_considered INTEGER NOT NULL DEFAULT 0,
  articles_clustered INTEGER NOT NULL DEFAULT 0,
  clusters_created INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_story_clusters_category_latest
  ON story_clusters (category_id, latest_published_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_clusters_latest
  ON story_clusters (latest_published_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_articles_cluster
  ON cluster_articles (cluster_id, added_at DESC);
