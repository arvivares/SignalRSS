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

export function chooseTarget(left, right) {
  if (left.article_count !== right.article_count) {
    return left.article_count > right.article_count ? [left, right] : [right, left];
  }
  const leftDate = new Date(left.latest_published_at || 0).getTime();
  const rightDate = new Date(right.latest_published_at || 0).getTime();
  if (leftDate !== rightDate) return leftDate > rightDate ? [left, right] : [right, left];
  return left.id < right.id ? [left, right] : [right, left];
}

async function loadClusters() {
  const params = [
    config.embeddingModel,
    config.clusterMergeWindowDays,
  ];
  let categoryFilter = '';

  if (config.clusterMergeCategorySlug) {
    params.push(config.clusterMergeCategorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.category_id,
      tc.slug AS category_slug,
      sc.centroid_embedding,
      sc.article_count,
      sc.first_published_at,
      sc.latest_published_at
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    WHERE sc.embedding_model = $1
      AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 day')
      AND sc.latest_published_at <= NOW()
      ${categoryFilter}
    ORDER BY sc.latest_published_at DESC NULLS LAST, sc.article_count DESC
  `, params);

  return rows.map((cluster) => ({
    ...cluster,
    centroid_embedding: parseEmbedding(cluster.centroid_embedding),
  }));
}

function findMergePairs(clusters) {
  const pairs = [];

  for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
      const left = clusters[leftIndex];
      const right = clusters[rightIndex];
      if (left.category_id !== right.category_id) continue;

      const similarity = dotProduct(left.centroid_embedding, right.centroid_embedding);
      if (similarity < config.clusterMergeSimilarityThreshold) continue;

      const [target, source] = chooseTarget(left, right);
      pairs.push({
        target,
        source,
        similarity: Number(similarity.toFixed(6)),
      });
    }
  }

  const usedSourceIds = new Set();
  const usedTargetIds = new Set();
  return pairs
    .sort((left, right) => right.similarity - left.similarity)
    .filter((pair) => {
      if (usedSourceIds.has(pair.source.id)) return false;
      if (usedSourceIds.has(pair.target.id)) return false;
      if (usedTargetIds.has(pair.source.id)) return false;
      usedSourceIds.add(pair.source.id);
      usedTargetIds.add(pair.target.id);
      return true;
    })
    .slice(0, config.clusterMergeBatchSize);
}

async function recalculateCluster(client, clusterId) {
  const { rows } = await client.query(`
    SELECT
      ae.embedding,
      a.published_at,
      a.first_seen_at,
      ca.role
    FROM cluster_articles ca
    JOIN articles a ON a.id = ca.article_id
    JOIN article_embeddings ae
      ON ae.article_id = a.id
      AND ae.embedding_model = $2
    WHERE ca.cluster_id = $1
  `, [clusterId, config.embeddingModel]);

  if (rows.length === 0) return;

  const normalizedEmbeddings = rows.map((row) => normalize(parseEmbedding(row.embedding)));
  const centroid = normalize(normalizedEmbeddings[0].map((_, dimension) => (
    normalizedEmbeddings.reduce((total, embedding) => total + embedding[dimension], 0) / normalizedEmbeddings.length
  )));
  const dates = rows.map((row) => row.published_at || row.first_seen_at).filter(Boolean);
  const firstPublishedAt = dates.reduce((oldest, value) => (
    !oldest || new Date(value) < new Date(oldest) ? value : oldest
  ), null);
  const latestPublishedAt = dates.reduce((latest, value) => (
    !latest || new Date(value) > new Date(latest) ? value : latest
  ), null);

  await client.query(`
    UPDATE story_clusters
    SET centroid_embedding = $2::jsonb,
        article_count = $3,
        first_published_at = $4,
        latest_published_at = $5,
        updated_at = NOW()
    WHERE id = $1
  `, [
    clusterId,
    JSON.stringify(centroid),
    rows.length,
    firstPublishedAt,
    latestPublishedAt,
  ]);
}

export async function mergePair(pair) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE cluster_articles
      SET cluster_id = $1,
          role = CASE WHEN role = 'representative' THEN 'member' ELSE role END
      WHERE cluster_id = $2
    `, [pair.target.id, pair.source.id]);

    await client.query(`
      UPDATE mattermost_notifications mn
      SET cluster_id = $1,
          updated_at = NOW()
      WHERE mn.cluster_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM mattermost_notifications existing
          WHERE existing.cluster_id = $1
            AND existing.locale = mn.locale
            AND existing.briefing_type = mn.briefing_type
            AND existing.destination_hash = mn.destination_hash
            AND existing.status IN ('processing', 'posted', 'skipped_existing')
        )
    `, [pair.target.id, pair.source.id]);

    await recalculateCluster(client, pair.target.id);

    await client.query('DELETE FROM cluster_impact_scores WHERE cluster_id IN ($1, $2)', [
      pair.target.id,
      pair.source.id,
    ]);

    await client.query('DELETE FROM story_clusters WHERE id = $1', [pair.source.id]);
    await client.query('COMMIT');

    return {
      merged: true,
      target_id: pair.target.id,
      source_id: pair.source.id,
      similarity: pair.similarity,
      target_title: pair.target.title,
      source_title: pair.source.title,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runClusterMerge({
  closeConnections = true,
  runUntilStable = config.clusterMergeRunUntilStable,
} = {}) {
  try {
    let totalMerged = 0;
    let pass = 0;

    do {
      pass += 1;
      const clusters = await loadClusters();
      const pairs = findMergePairs(clusters);
      let merged = 0;

      for (const pair of pairs) {
        const result = await mergePair(pair);
        if (result.merged) {
          merged += 1;
          console.log(`Merged ${result.source_id} -> ${result.target_id} similarity=${result.similarity}`);
        }
      }

      totalMerged += merged;
      console.log(`Cluster merge pass ${pass}: merged ${merged}/${pairs.length}`);
      if (merged === 0) break;
    } while (runUntilStable);

    console.log(`Merged ${totalMerged} clusters total`);
  } finally {
    if (closeConnections) await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClusterMerge().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
