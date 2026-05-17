CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS source_host TEXT;

ALTER TABLE article_embeddings
  ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

ALTER TABLE story_clusters
  ADD COLUMN IF NOT EXISTS centroid_embedding_vector vector(1536);

UPDATE articles
SET source_host = regexp_replace(coalesce(canonical_url, ''), '^https?://(www\.)?([^/]+).*$' , '\2')
WHERE source_host IS NULL
  AND canonical_url IS NOT NULL
  AND canonical_url <> '';

CREATE INDEX IF NOT EXISTS idx_articles_source_host
  ON articles (source_host)
  WHERE source_host IS NOT NULL AND source_host <> '';

UPDATE article_embeddings
SET embedding_vector = (
  SELECT ('[' || string_agg(value::text, ',' ORDER BY ordinality) || ']')::vector
  FROM jsonb_array_elements_text(embedding) WITH ORDINALITY AS elems(value, ordinality)
)
WHERE embedding_vector IS NULL
  AND embedding_dimensions = 1536;

UPDATE story_clusters
SET centroid_embedding_vector = (
  SELECT ('[' || string_agg(value::text, ',' ORDER BY ordinality) || ']')::vector
  FROM jsonb_array_elements_text(centroid_embedding) WITH ORDINALITY AS elems(value, ordinality)
)
WHERE centroid_embedding_vector IS NULL;

CREATE INDEX IF NOT EXISTS idx_article_embeddings_vector_hnsw
  ON article_embeddings
  USING hnsw (embedding_vector vector_cosine_ops)
  WHERE embedding_vector IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_story_clusters_centroid_vector_hnsw
  ON story_clusters
  USING hnsw (centroid_embedding_vector vector_cosine_ops)
  WHERE centroid_embedding_vector IS NOT NULL;
