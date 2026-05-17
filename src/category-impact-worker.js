import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb, pool } from './db.js';
import { enqueueImpactJobs, runImpactScoring } from './score-impact.js';
import { loadActiveCategorySlugs, withImpactCategory } from './category-runtime.js';

let shuttingDown = false;

async function loadImpactWorkItems() {
  const categories = await loadActiveCategorySlugs();
  if (categories.length === 0) return [];

  const params = [
    categories,
    config.embeddingModel,
    config.impactWindowHours,
  ];
  let minPublishedAtFilter = '';

  if (config.impactMinPublishedAt) {
    params.push(config.impactMinPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  const { rows } = await pool.query(`
    SELECT
      tc.slug,
      min(sc.latest_published_at) AS oldest_pending_at,
      count(*)::int AS impact_backlog
    FROM cluster_impact_jobs j
    JOIN story_clusters sc ON sc.id = j.cluster_id
    JOIN topic_categories tc ON tc.id = sc.category_id
    WHERE tc.slug = ANY($1::text[])
      AND j.status = 'pending'
      AND sc.embedding_model = $2
      AND sc.latest_published_at >= NOW() - ($3::int * INTERVAL '1 hour')
      ${minPublishedAtFilter}
      AND sc.latest_published_at <= NOW()
      AND EXISTS (
        SELECT 1
        FROM cluster_articles ca
        WHERE ca.cluster_id = sc.id
      )
    GROUP BY tc.slug
  `, params);

  const categoryOrder = new Map(categories.map((slug, index) => [slug, index]));
  return rows
    .map((row) => ({
      categorySlug: row.slug,
      categoryIndex: categoryOrder.get(row.slug) ?? Number.MAX_SAFE_INTEGER,
      backlog: Number(row.impact_backlog || 0),
      oldestPendingAt: row.oldest_pending_at,
    }))
    .filter((item) => item.backlog > 0)
    .sort((left, right) => {
      if (right.backlog !== left.backlog) return right.backlog - left.backlog;
      const leftOldest = left.oldestPendingAt ? new Date(left.oldestPendingAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightOldest = right.oldestPendingAt ? new Date(right.oldestPendingAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftOldest !== rightOldest) return leftOldest - rightOldest;
      return left.categoryIndex - right.categoryIndex;
    });
}

async function tick() {
  if (shuttingDown) return;
  try {
    withImpactCategory('');
    await enqueueImpactJobs();

    const workItems = (await loadImpactWorkItems()).slice(0, config.categoryImpactCategoriesPerTick);
    console.log(
      `Category impact worker work=${workItems
        .map((item) => `${item.categorySlug}:${item.backlog}`)
        .join(',') || 'none'}`,
    );

    for (const item of workItems) {
      if (shuttingDown) return;
      withImpactCategory(item.categorySlug);
      await runImpactScoring({
        closeConnections: false,
        runUntilEmpty: false,
        maxBatches: config.impactBatchesPerTick,
      });
    }
    withImpactCategory('');
  } catch (error) {
    console.error('Category impact failed:', error);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  withImpactCategory('');
  console.log(
    `Category impact worker polling every ${config.impactPollIntervalSeconds}s; ` +
      `${config.impactBatchesPerTick} batch(es) per category; ` +
      `${config.categoryImpactCategoriesPerTick} categor(y/ies) per tick`,
  );
  while (!shuttingDown) {
    await tick();
    await sleep(config.impactPollIntervalSeconds * 1000);
  }
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
