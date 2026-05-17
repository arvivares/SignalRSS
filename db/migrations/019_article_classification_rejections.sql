CREATE TABLE IF NOT EXISTS article_classification_rejections (
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  top_category_id UUID REFERENCES topic_categories(id) ON DELETE SET NULL,
  top_category_slug TEXT,
  top_confidence NUMERIC(8, 6),
  min_confidence NUMERIC(8, 6) NOT NULL,
  reason TEXT NOT NULL,
  article_updated_at TIMESTAMPTZ NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (article_id, model)
);

CREATE INDEX IF NOT EXISTS idx_article_classification_rejections_rejected
  ON article_classification_rejections (model, rejected_at DESC);
