ALTER TABLE article_classification_rejections
  ADD COLUMN IF NOT EXISTS second_category_slug TEXT,
  ADD COLUMN IF NOT EXISTS second_confidence NUMERIC(8, 6),
  ADD COLUMN IF NOT EXISTS min_margin NUMERIC(8, 6),
  ADD COLUMN IF NOT EXISTS confidence_margin NUMERIC(8, 6);

CREATE INDEX IF NOT EXISTS idx_article_classification_rejections_top_category
  ON article_classification_rejections (model, top_category_slug, reason, rejected_at DESC);
