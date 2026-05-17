import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';

function parseEmbedding(value) {
  return Array.isArray(value) ? value : JSON.parse(value);
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function vectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

function mergeCentroid(current, next, count) {
  return normalize(current.map((value, index) => ((value * count) + next[index]) / (count + 1)));
}

function thresholdForArticle(article) {
  return thresholdForCategory(article.category_slug);
}

function thresholdForCategory(categorySlug) {
  return config.clusterSimilarityThresholds[categorySlug] ?? config.clusterSimilarityThreshold;
}

async function loadCandidateArticles() {
  const params = [config.embeddingModel, config.clusterWindowDays, config.clusterBatchSize];
  let categoryFilter = '';
  if (config.clusterCategorySlug) {
    params.push(config.clusterCategorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT
       a.id,
       a.title,
       a.summary,
       a.canonical_url,
       a.published_at,
       a.first_seen_at,
       ae.embedding,
       tc.id AS category_id,
       tc.slug AS category_slug
     FROM articles a
     JOIN article_embeddings ae
       ON ae.article_id = a.id
       AND ae.embedding_model = $1
     JOIN article_classifications ac
       ON ac.article_id = a.id
       AND ac.model = $1
       AND ac.rank = 1
     JOIN topic_categories tc
       ON tc.id = ac.category_id
     WHERE a.published_at >= NOW() - ($2::int * INTERVAL '1 day')
       AND a.published_at <= NOW()
       ${categoryFilter}
       AND NOT EXISTS (
         SELECT 1
         FROM cluster_articles ca
         WHERE ca.article_id = a.id
       )
     ORDER BY a.published_at DESC NULLS LAST, a.first_seen_at DESC
     LIMIT $3`,
    params,
  );

  return rows.map((row) => ({
    ...row,
    embedding: parseEmbedding(row.embedding),
  }));
}

export async function hasClusteringWork() {
  const params = [config.embeddingModel, config.clusterWindowDays];
  let categoryFilter = '';
  if (config.clusterCategorySlug) {
    params.push(config.clusterCategorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rowCount } = await pool.query(
    `SELECT 1
     FROM articles a
     JOIN article_embeddings ae
       ON ae.article_id = a.id
       AND ae.embedding_model = $1
     JOIN article_classifications ac
       ON ac.article_id = a.id
       AND ac.model = $1
       AND ac.rank = 1
     JOIN topic_categories tc
       ON tc.id = ac.category_id
     WHERE a.published_at >= NOW() - ($2::int * INTERVAL '1 day')
       AND a.published_at <= NOW()
       ${categoryFilter}
       AND NOT EXISTS (
         SELECT 1
         FROM cluster_articles ca
         WHERE ca.article_id = a.id
       )
     LIMIT 1`,
    params,
  );

  return rowCount > 0;
}

async function loadNearestClusters(article) {
  const normalizedArticleEmbedding = normalize(article.embedding);
  const { rows } = await pool.query(
    `SELECT
       id,
       centroid_embedding,
       article_count,
       1 - (centroid_embedding_vector <=> $4::vector) AS similarity
     FROM story_clusters
     WHERE embedding_model = $1
       AND category_id = $2
       AND latest_published_at >= NOW() - ($3::int * INTERVAL '1 day')
       AND centroid_embedding_vector IS NOT NULL
     ORDER BY centroid_embedding_vector <=> $4::vector
     LIMIT 20`,
    [
      config.embeddingModel,
      article.category_id,
      config.clusterWindowDays,
      vectorLiteral(normalizedArticleEmbedding),
    ],
  );

  return rows.map((row) => ({
    ...row,
    centroid_embedding: parseEmbedding(row.centroid_embedding),
    similarity: Number(row.similarity || 0),
  }));
}

async function createCluster(client, article) {
  const centroid = normalize(article.embedding);
  const { rows } = await client.query(
    `INSERT INTO story_clusters (
       title,
       summary,
       category_id,
       representative_article_id,
       centroid_embedding,
       centroid_embedding_vector,
       embedding_model,
       article_count,
       first_published_at,
       latest_published_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7, 1, $8, $8, NOW())
     RETURNING id`,
    [
      article.title,
      article.summary,
      article.category_id,
      article.id,
      JSON.stringify(centroid),
      vectorLiteral(centroid),
      config.embeddingModel,
      article.published_at || article.first_seen_at,
    ],
  );

  const clusterId = rows[0].id;
  await client.query(
    `INSERT INTO cluster_articles (cluster_id, article_id, similarity, role)
     VALUES ($1, $2, 1.0, 'representative')`,
    [clusterId, article.id],
  );

  return clusterId;
}

async function attachToCluster(client, article, cluster, similarity) {
  const nextCentroid = mergeCentroid(
    cluster.centroid_embedding,
    normalize(article.embedding),
    cluster.article_count,
  );
  const publishedAt = article.published_at || article.first_seen_at;

  await client.query(
    `INSERT INTO cluster_articles (cluster_id, article_id, similarity, role)
     VALUES ($1, $2, $3, 'member')
     ON CONFLICT (article_id) DO NOTHING`,
    [cluster.id, article.id, similarity],
  );

  await client.query(
    `UPDATE story_clusters
     SET centroid_embedding = $2::jsonb,
         centroid_embedding_vector = $4::vector,
         article_count = article_count + 1,
         first_published_at = LEAST(first_published_at, $3),
         latest_published_at = GREATEST(latest_published_at, $3),
         updated_at = NOW()
     WHERE id = $1`,
    [cluster.id, JSON.stringify(nextCentroid), publishedAt, vectorLiteral(nextCentroid)],
  );
}

async function clusterArticle(article) {
  const clusters = await loadNearestClusters(article);
  let bestCluster = null;
  let bestSimilarity = -1;

  for (const cluster of clusters) {
    const similarity = cluster.similarity || dotProduct(normalize(article.embedding), cluster.centroid_embedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCluster = cluster;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (bestCluster && bestSimilarity >= thresholdForArticle(article)) {
      await attachToCluster(client, article, bestCluster, Number(bestSimilarity.toFixed(6)));
      await client.query('COMMIT');
      return { clustered: true, created: false };
    }

    await createCluster(client, article);
    await client.query('COMMIT');
    return { clustered: true, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return { clustered: false, created: false };
    throw error;
  } finally {
    client.release();
  }
}

export async function runClustering({ closeConnections = true, runUntilEmpty = config.clusterRunUntilEmpty } = {}) {
  const runThreshold = thresholdForCategory(config.clusterCategorySlug);
  const run = await pool.query(
    `INSERT INTO clustering_runs (status, model, similarity_threshold)
     VALUES ('running', $1, $2)
     RETURNING id`,
    [config.embeddingModel, runThreshold],
  );
  const runId = run.rows[0].id;

  try {
    let considered = 0;
    let clustered = 0;
    let created = 0;
    let batch = 0;

    do {
      batch += 1;
      const articles = await loadCandidateArticles();
      let batchClustered = 0;
      let batchCreated = 0;

      for (const article of articles) {
        const result = await clusterArticle(article);
        if (result.clustered) batchClustered += 1;
        if (result.created) batchCreated += 1;
      }

      considered += articles.length;
      clustered += batchClustered;
      created += batchCreated;
      console.log(`Cluster batch ${batch}: clustered ${batchClustered}/${articles.length}, created=${batchCreated}`);
      if (articles.length === 0) break;
    } while (runUntilEmpty);

    await pool.query(
      `UPDATE clustering_runs
       SET status = 'ok',
           finished_at = NOW(),
           articles_considered = $2,
           articles_clustered = $3,
           clusters_created = $4
       WHERE id = $1`,
      [runId, considered, clustered, created],
    );

    console.log(`Clustered ${clustered}/${considered} articles; created ${created} clusters`);
  } catch (error) {
    await pool.query(
      `UPDATE clustering_runs
       SET status = 'failed',
           finished_at = NOW(),
           error = $2
       WHERE id = $1`,
      [runId, error.message],
    );
    throw error;
  } finally {
    if (closeConnections) await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClustering().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
