CREATE TABLE IF NOT EXISTS topic_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  embedding JSONB,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_input_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS article_embeddings (
  article_id UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  embedding JSONB NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding_input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS article_classifications (
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES topic_categories(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  confidence NUMERIC(7, 6) NOT NULL,
  method TEXT NOT NULL,
  model TEXT NOT NULL,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (article_id, category_id, model)
);

CREATE TABLE IF NOT EXISTS classification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  articles_considered INTEGER NOT NULL DEFAULT 0,
  articles_classified INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_classifications_article_rank
  ON article_classifications (article_id, model, rank);

CREATE INDEX IF NOT EXISTS idx_article_classifications_category_confidence
  ON article_classifications (category_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_topic_categories_active
  ON topic_categories (active, sort_order, name);
