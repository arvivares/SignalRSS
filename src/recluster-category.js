import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { runClustering } from './cluster-articles.js';
import { withClusterCategory } from './category-runtime.js';

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

function thresholdForCategory(categorySlug) {
  return config.clusterSimilarityThresholds[categorySlug] ?? config.clusterSimilarityThreshold;
}

async function loadCategory(categorySlug) {
  const { rows } = await pool.query(
    'SELECT id, slug FROM topic_categories WHERE slug = $1 AND active = TRUE',
    [categorySlug],
  );
  return rows[0] || null;
}

async function cleanupCategoryClusters(categorySlug, windowDays) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: clusterRows } = await client.query(
      `SELECT sc.id
       FROM story_clusters sc
       JOIN topic_categories tc ON tc.id = sc.category_id
       WHERE tc.slug = $1
         AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 day')
       FOR UPDATE OF sc`,
      [categorySlug, windowDays],
    );

    const clusterIds = clusterRows.map((row) => row.id);
    const counts = {
      clusters: clusterIds.length,
      priorityAdjudications: 0,
      crossCategoryAdjudications: 0,
      deletedClusters: 0,
    };

    if (clusterIds.length === 0) {
      await client.query('COMMIT');
      return counts;
    }

    for (const tableName of PRIORITY_ADJUDICATION_TABLES) {
      const result = await client.query(
        `DELETE FROM ${tableName}
         WHERE left_cluster_id = ANY($1::uuid[])
            OR right_cluster_id = ANY($1::uuid[])
            OR target_cluster_id = ANY($1::uuid[])
            OR source_cluster_id = ANY($1::uuid[])`,
        [clusterIds],
      );
      counts.priorityAdjudications += result.rowCount;
    }

    const crossCategory = await client.query(
      `DELETE FROM cross_category_cluster_adjudications
       WHERE left_cluster_id = ANY($1::uuid[])
          OR right_cluster_id = ANY($1::uuid[])
          OR target_cluster_id = ANY($1::uuid[])
          OR source_cluster_id = ANY($1::uuid[])`,
      [clusterIds],
    );
    counts.crossCategoryAdjudications = crossCategory.rowCount;

    const deletedClusters = await client.query(
      'DELETE FROM story_clusters WHERE id = ANY($1::uuid[])',
      [clusterIds],
    );
    counts.deletedClusters = deletedClusters.rowCount;

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function reclusterCategory({
  categorySlug,
  windowDays = config.clusterWindowDays,
  closeConnections = true,
} = {}) {
  if (!categorySlug) {
    throw new Error('Category slug is required. Usage: npm run maintenance:recluster-category -- software-development [windowDays]');
  }

  const category = await loadCategory(categorySlug);
  if (!category) throw new Error(`Active category not found: ${categorySlug}`);

  const normalizedWindowDays = parseWindowDays(windowDays);
  const threshold = thresholdForCategory(categorySlug);

  console.log(`Recluster category=${categorySlug} window_days=${normalizedWindowDays} threshold=${threshold}`);
  const cleanup = await cleanupCategoryClusters(categorySlug, normalizedWindowDays);
  console.log(
    `Deleted clusters=${cleanup.deletedClusters}/${cleanup.clusters}, ` +
      `priority_adjudications=${cleanup.priorityAdjudications}, ` +
      `cross_category_adjudications=${cleanup.crossCategoryAdjudications}`,
  );

  withClusterCategory(categorySlug);
  config.clusterWindowDays = normalizedWindowDays;
  await runClustering({ closeConnections: false, runUntilEmpty: true });

  if (closeConnections) await closeDb();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  reclusterCategory({
    categorySlug: process.argv[2],
    windowDays: process.argv[3],
  }).catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
