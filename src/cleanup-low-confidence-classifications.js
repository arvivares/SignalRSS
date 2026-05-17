import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';

const PRIORITY_ADJUDICATION_TABLES = [
  'p0_cluster_merge_adjudications',
  'p1_cluster_merge_adjudications',
  'p2_cluster_merge_adjudications',
  'p3_cluster_merge_adjudications',
];

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

function minConfidenceForCategory(slug) {
  return config.classifierMinConfidenceByCategory[slug] ?? config.classifierMinConfidence;
}

function minMarginForCategory(slug) {
  return config.classifierMinMarginByCategory[slug] ?? config.classifierMinMargin;
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

async function loadLowConfidenceArticles(client, windowDays) {
  const { rows } = await client.query(
    `SELECT
       ac.article_id,
       ac.category_id AS top_category_id,
       tc.slug AS top_category_slug,
       ac.confidence AS top_confidence,
       second_tc.slug AS second_category_slug,
       second_ac.confidence AS second_confidence,
       CASE
         WHEN second_ac.confidence IS NULL THEN NULL
         ELSE ac.confidence - second_ac.confidence
       END AS confidence_margin,
       a.updated_at AS article_updated_at,
       ca.cluster_id
     FROM article_classifications ac
     JOIN articles a ON a.id = ac.article_id
     JOIN topic_categories tc ON tc.id = ac.category_id
     LEFT JOIN article_classifications second_ac
       ON second_ac.article_id = ac.article_id
      AND second_ac.model = ac.model
      AND second_ac.rank = 2
     LEFT JOIN topic_categories second_tc ON second_tc.id = second_ac.category_id
     LEFT JOIN cluster_articles ca ON ca.article_id = ac.article_id
     WHERE ac.model = $1
       AND ac.rank = 1
       AND (
         ac.confidence < coalesce(($3::jsonb ->> tc.slug)::numeric, $2::numeric)
         OR (
           second_ac.confidence IS NOT NULL
           AND ac.confidence - second_ac.confidence < coalesce(($4::jsonb ->> tc.slug)::numeric, $5::numeric)
         )
       )
       AND a.published_at >= NOW() - ($6::int * INTERVAL '1 day')
       AND a.published_at <= NOW()
     ORDER BY ac.confidence ASC, a.updated_at DESC`,
    [
      config.embeddingModel,
      config.classifierMinConfidence,
      JSON.stringify(config.classifierMinConfidenceByCategory),
      JSON.stringify(config.classifierMinMarginByCategory),
      config.classifierMinMargin,
      windowDays,
    ],
  );
  return rows;
}

export async function cleanupLowConfidenceClassifications({
  windowDays = config.clusterWindowDays,
  closeConnections = true,
} = {}) {
  const client = await pool.connect();
  const counts = {
    rejectedArticles: 0,
    deletedClassifications: 0,
    removedClusterLinks: 0,
    affectedClusters: 0,
    deletedClusters: 0,
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };

  try {
    await client.query('BEGIN');
    const rejected = await loadLowConfidenceArticles(client, windowDays);
    const articleIds = [...new Set(rejected.map((row) => row.article_id))];
    const clusterIds = [...new Set(rejected.map((row) => row.cluster_id).filter(Boolean))];
    counts.rejectedArticles = articleIds.length;
    counts.affectedClusters = clusterIds.length;

    if (articleIds.length === 0) {
      await client.query('COMMIT');
      console.log(JSON.stringify(counts, null, 2));
      return counts;
    }

    await client.query(
      `INSERT INTO article_classification_rejections (
         article_id, model, top_category_id, top_category_slug, top_confidence,
         second_category_slug, second_confidence, min_confidence, min_margin,
         confidence_margin, reason, article_updated_at, rejected_at
       )
       SELECT DISTINCT ON (article_id)
         article_id, $2, top_category_id, top_category_slug, top_confidence,
         second_category_slug, second_confidence, min_confidence, min_margin,
         confidence_margin, reason, article_updated_at, NOW()
       FROM jsonb_to_recordset($1::jsonb) AS rejected_rows(
         article_id uuid,
         top_category_id uuid,
         top_category_slug text,
         top_confidence numeric,
         second_category_slug text,
         second_confidence numeric,
         min_confidence numeric,
         min_margin numeric,
         confidence_margin numeric,
         reason text,
         article_updated_at timestamptz
       )
       ORDER BY article_id, top_confidence DESC
       ON CONFLICT (article_id, model) DO UPDATE SET
         top_category_id = EXCLUDED.top_category_id,
         top_category_slug = EXCLUDED.top_category_slug,
         top_confidence = EXCLUDED.top_confidence,
         second_category_slug = EXCLUDED.second_category_slug,
         second_confidence = EXCLUDED.second_confidence,
         min_confidence = EXCLUDED.min_confidence,
         min_margin = EXCLUDED.min_margin,
         confidence_margin = EXCLUDED.confidence_margin,
         reason = EXCLUDED.reason,
         article_updated_at = EXCLUDED.article_updated_at,
         rejected_at = NOW()`,
      [
        JSON.stringify(rejected.map((row) => ({
          article_id: row.article_id,
          top_category_id: row.top_category_id,
          top_category_slug: row.top_category_slug,
          top_confidence: row.top_confidence,
          second_category_slug: row.second_category_slug,
          second_confidence: row.second_confidence,
          min_confidence: minConfidenceForCategory(row.top_category_slug),
          min_margin: minMarginForCategory(row.top_category_slug),
          confidence_margin: row.confidence_margin,
          reason: Number(row.top_confidence) < minConfidenceForCategory(row.top_category_slug)
            ? 'top_category_below_min_confidence'
            : 'top_category_below_min_margin',
          article_updated_at: row.article_updated_at,
        }))),
        config.embeddingModel,
      ],
    );

    counts.deletedClassifications = (await client.query(
      'DELETE FROM article_classifications WHERE article_id = ANY($1::uuid[]) AND model = $2',
      [articleIds, config.embeddingModel],
    )).rowCount;

    const invalidated = await invalidateClusterArtifacts(client, clusterIds);
    Object.assign(counts, invalidated);

    counts.removedClusterLinks = (await client.query(
      'DELETE FROM cluster_articles WHERE article_id = ANY($1::uuid[])',
      [articleIds],
    )).rowCount;

    for (const clusterId of clusterIds) {
      const result = await recalculateCluster(client, clusterId);
      if (result.deleted) counts.deletedClusters += 1;
    }

    await client.query('COMMIT');
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
  cleanupLowConfidenceClassifications({
    windowDays: Number(process.argv[2]) || config.clusterWindowDays,
  }).catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
