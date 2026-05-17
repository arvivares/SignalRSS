import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';

const PRIORITY_ADJUDICATION_TABLES = [
  'p0_cluster_merge_adjudications',
  'p1_cluster_merge_adjudications',
  'p2_cluster_merge_adjudications',
  'p3_cluster_merge_adjudications',
];

function parseWindowDays(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return config.clusterWindowDays;
  return parsed;
}

function parseEmbedding(value) {
  return Array.isArray(value) ? value : JSON.parse(value);
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function vectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

async function invalidateClusterArtifacts(client, clusterIds) {
  const ids = [...new Set(clusterIds.filter(Boolean))];
  const counts = {
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };
  if (ids.length === 0) return counts;

  for (const tableName of PRIORITY_ADJUDICATION_TABLES) {
    const result = await client.query(
      `DELETE FROM ${tableName}
       WHERE left_cluster_id = ANY($1::uuid[])
          OR right_cluster_id = ANY($1::uuid[])
          OR target_cluster_id = ANY($1::uuid[])
          OR source_cluster_id = ANY($1::uuid[])`,
      [ids],
    );
    counts.priorityAdjudications += result.rowCount;
  }

  counts.crossCategoryAdjudications = (await client.query(
    `DELETE FROM cross_category_cluster_adjudications
     WHERE left_cluster_id = ANY($1::uuid[])
        OR right_cluster_id = ANY($1::uuid[])
        OR target_cluster_id = ANY($1::uuid[])
        OR source_cluster_id = ANY($1::uuid[])`,
    [ids],
  )).rowCount;
  counts.briefings = (await client.query('DELETE FROM cluster_briefings WHERE cluster_id = ANY($1::uuid[])', [ids])).rowCount;
  counts.impactScores = (await client.query('DELETE FROM cluster_impact_scores WHERE cluster_id = ANY($1::uuid[])', [ids])).rowCount;
  counts.impactJobs = (await client.query('DELETE FROM cluster_impact_jobs WHERE cluster_id = ANY($1::uuid[])', [ids])).rowCount;
  return counts;
}

async function recalculateCluster(client, clusterId) {
  const { rows } = await client.query(
    `SELECT
       ca.article_id,
       ca.role,
       a.title,
       a.summary,
       a.published_at,
       a.first_seen_at,
       ae.embedding
     FROM cluster_articles ca
     JOIN articles a ON a.id = ca.article_id
     JOIN article_embeddings ae
       ON ae.article_id = a.id
      AND ae.embedding_model = $2
     WHERE ca.cluster_id = $1
     ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST, a.first_seen_at DESC`,
    [clusterId, config.embeddingModel],
  );

  if (rows.length === 0) {
    await client.query('DELETE FROM story_clusters WHERE id = $1', [clusterId]);
    return { deleted: true };
  }

  const embeddings = rows.map((row) => normalize(parseEmbedding(row.embedding)));
  const centroid = normalize(embeddings[0].map((_, index) => (
    embeddings.reduce((total, embedding) => total + embedding[index], 0) / embeddings.length
  )));
  const representative = rows[0];
  const publishedDates = rows
    .map((row) => row.published_at || row.first_seen_at)
    .filter(Boolean)
    .map((value) => new Date(value));
  const firstPublishedAt = new Date(Math.min(...publishedDates.map((date) => date.getTime())));
  const latestPublishedAt = new Date(Math.max(...publishedDates.map((date) => date.getTime())));

  await client.query(
    `UPDATE story_clusters
     SET title = $2,
         summary = $3,
         representative_article_id = $4,
         centroid_embedding = $5::jsonb,
         centroid_embedding_vector = $6::vector,
         article_count = $7,
         first_published_at = $8,
         latest_published_at = $9,
         updated_at = NOW()
     WHERE id = $1`,
    [
      clusterId,
      representative.title,
      representative.summary,
      representative.article_id,
      JSON.stringify(centroid),
      vectorLiteral(centroid),
      rows.length,
      firstPublishedAt,
      latestPublishedAt,
    ],
  );

  await client.query(
    `UPDATE cluster_articles
     SET role = CASE WHEN cluster_articles.article_id = $2 THEN 'representative' ELSE 'member' END,
         similarity = similarity_updates.similarity
     FROM (
       SELECT unnest($3::uuid[]) AS article_id, unnest($4::numeric[]) AS similarity
     ) similarity_updates
     WHERE cluster_articles.cluster_id = $1
       AND cluster_articles.article_id = similarity_updates.article_id`,
    [
      clusterId,
      representative.article_id,
      rows.map((row) => row.article_id),
      embeddings.map((embedding) => Number(dotProduct(embedding, centroid).toFixed(6))),
    ],
  );

  return { deleted: false };
}

async function loadCandidateArticles(client, categorySlug, windowDays) {
  const { rows } = await client.query(
    `WITH target_category AS (
       SELECT id FROM topic_categories WHERE slug = $2
     ),
     candidates AS (
       SELECT DISTINCT ac.article_id
       FROM article_classifications ac
       JOIN articles a ON a.id = ac.article_id
       WHERE ac.model = $1
         AND ac.category_id = (SELECT id FROM target_category)
         AND ac.rank IN (1, 2)
         AND a.published_at >= NOW() - ($3::int * INTERVAL '1 day')
         AND a.published_at <= NOW()

       UNION

       SELECT DISTINCT acr.article_id
       FROM article_classification_rejections acr
       JOIN articles a ON a.id = acr.article_id
       WHERE acr.model = $1
         AND (
           acr.top_category_slug = $2
           OR acr.second_category_slug = $2
         )
         AND a.published_at >= NOW() - ($3::int * INTERVAL '1 day')
         AND a.published_at <= NOW()
     )
     SELECT c.article_id, ca.cluster_id
     FROM candidates c
     LEFT JOIN cluster_articles ca ON ca.article_id = c.article_id`,
    [config.embeddingModel, categorySlug, windowDays],
  );
  return rows;
}

export async function reclassifyCategoryCandidates({
  categorySlug = 'cloud-infrastructure',
  windowDays = config.clusterWindowDays,
  closeConnections = true,
} = {}) {
  if (!categorySlug) throw new Error('categorySlug is required');
  const normalizedWindowDays = parseWindowDays(windowDays);
  const client = await pool.connect();
  const counts = {
    candidateArticles: 0,
    affectedClusters: 0,
    deletedClassifications: 0,
    deletedRejections: 0,
    removedClusterLinks: 0,
    deletedClusters: 0,
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };

  try {
    await client.query('BEGIN');
    const candidates = await loadCandidateArticles(client, categorySlug, normalizedWindowDays);
    const articleIds = [...new Set(candidates.map((row) => row.article_id))];
    const clusterIds = [...new Set(candidates.map((row) => row.cluster_id).filter(Boolean))];
    counts.candidateArticles = articleIds.length;
    counts.affectedClusters = clusterIds.length;

    if (articleIds.length === 0) {
      await client.query('COMMIT');
      console.log(JSON.stringify(counts, null, 2));
      return counts;
    }

    const invalidated = await invalidateClusterArtifacts(client, clusterIds);
    Object.assign(counts, invalidated);

    counts.removedClusterLinks = (await client.query(
      'DELETE FROM cluster_articles WHERE article_id = ANY($1::uuid[])',
      [articleIds],
    )).rowCount;

    counts.deletedClassifications = (await client.query(
      'DELETE FROM article_classifications WHERE article_id = ANY($1::uuid[]) AND model = $2',
      [articleIds, config.embeddingModel],
    )).rowCount;

    counts.deletedRejections = (await client.query(
      'DELETE FROM article_classification_rejections WHERE article_id = ANY($1::uuid[]) AND model = $2',
      [articleIds, config.embeddingModel],
    )).rowCount;

    for (const clusterId of clusterIds) {
      const result = await recalculateCluster(client, clusterId);
      if (result.deleted) counts.deletedClusters += 1;
    }

    await client.query('COMMIT');
    counts.categorySlug = categorySlug;
    console.log(JSON.stringify(counts, null, 2));
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (closeConnections) await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  reclassifyCategoryCandidates({
    categorySlug: process.argv[2] || 'cloud-infrastructure',
    windowDays: process.argv[3] || config.clusterWindowDays,
  }).catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
