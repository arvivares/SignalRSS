import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import { config } from './config.js';
import { closeDb, pool } from './db.js';
import {
  availablePriorityBriefingProviders,
  cleanupBriefingClaimsOlderThan,
  hasPriorityBriefingProviderAvailable,
  hasPriorityBriefingWork,
  runPriorityBriefings,
} from './generate-priority-briefings.js';
import { loadActiveCategorySlugs } from './category-runtime.js';
import { PRIORITY_LEVELS } from './priority-config.js';
import { isBriefingExcluded } from './briefing-exclusions.js';
import { batchSizeForBriefingProviders } from './briefing-batch-policy.js';

let shuttingDown = false;

const WORKER_ID = `${os.hostname()}-${process.pid}`;

function pollIntervalSeconds() {
  return Math.min(
    config.p0BriefingPollIntervalSeconds,
    config.p1BriefingPollIntervalSeconds,
    config.p2BriefingPollIntervalSeconds,
    config.p3BriefingPollIntervalSeconds,
  );
}

async function loadBriefingWorkItems() {
  const categories = await loadActiveCategorySlugs();
  if (categories.length === 0) return [];

  const params = [
    categories,
    PRIORITY_LEVELS,
    Math.max(
      config.p0BriefingWindowHours,
      config.p1BriefingWindowHours,
      config.p2BriefingWindowHours,
      config.p3BriefingWindowHours,
    ),
  ];
  let minPublishedAtFilter = '';

  if (config.briefingMinPublishedAt) {
    params.push(config.briefingMinPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  const { rows } = await pool.query(`
    SELECT
      tc.slug,
      cis.impact_level,
      min(sc.latest_published_at) AS oldest_pending_at,
      count(*)::int AS briefing_backlog
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    LEFT JOIN cluster_briefings cb
      ON cb.cluster_id = sc.id
      AND cb.locale = 'es'
      AND cb.briefing_type = lower(cis.impact_level) || '-cluster-briefing'
    WHERE tc.slug = ANY($1::text[])
      AND cis.impact_level = ANY($2::text[])
      AND sc.latest_published_at >= NOW() - ($3::int * INTERVAL '1 hour')
      ${minPublishedAtFilter}
      AND sc.latest_published_at <= NOW()
      AND (
        cb.cluster_id IS NULL
        OR cb.updated_at < sc.updated_at
        OR cb.updated_at < cis.updated_at
      )
    GROUP BY tc.slug, cis.impact_level
  `, params);

  const categoryOrder = new Map(categories.map((slug, index) => [slug, index]));
  const items = rows
    .map((row) => ({
      categorySlug: row.slug,
      level: row.impact_level,
      categoryIndex: categoryOrder.get(row.slug) ?? Number.MAX_SAFE_INTEGER,
      levelIndex: PRIORITY_LEVELS.indexOf(row.impact_level),
      backlog: Number(row.briefing_backlog || 0),
      oldestPendingAt: row.oldest_pending_at,
    }))
    .filter((item) => (
      item.backlog > 0
      && item.levelIndex >= 0
      && !isBriefingExcluded(item.categorySlug, item.level)
    ))
    .sort((left, right) => {
      if (right.backlog !== left.backlog) return right.backlog - left.backlog;
      const leftOldest = left.oldestPendingAt ? new Date(left.oldestPendingAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightOldest = right.oldestPendingAt ? new Date(right.oldestPendingAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftOldest !== rightOldest) return leftOldest - rightOldest;
      if (left.levelIndex !== right.levelIndex) return left.levelIndex - right.levelIndex;
      return left.categoryIndex - right.categoryIndex;
    });

  return items;
}

function workerWorkItems(items, workerSlot) {
  const slotIndex = workerSlot - 1;
  const owned = items.filter((_, index) => index % config.categoryBriefingConcurrency === slotIndex);
  return owned.length > 0 ? owned : items;
}

async function tick(workerSlot) {
  const workItems = workerWorkItems(await loadBriefingWorkItems(), workerSlot);
  console.log(
    `Category briefing worker: worker=${WORKER_ID}/${workerSlot} work=${workItems
      .map((item) => `${item.categorySlug}:${item.level}:${item.backlog}`)
      .join(',') || 'none'}`,
  );

  for (const item of workItems) {
    const categorySlug = item.categorySlug;
    const level = item.level;
    if (shuttingDown) return;
    if (isBriefingExcluded(categorySlug, level)) continue;
    try {
      if (!(await hasPriorityBriefingWork(level, { categorySlug }))) continue;
      const providers = await availablePriorityBriefingProviders(level, { categorySlug });
      if (providers.length === 0) {
        console.log(`Category briefing skipped category=${categorySlug} level=${level}: all providers cooling down`);
        continue;
      }
      if (!(await hasPriorityBriefingProviderAvailable(level, { categorySlug }))) continue;
      const batchSizeOverride = batchSizeForBriefingProviders(providers);
      console.log(
        `Category briefing run category=${categorySlug} level=${level} backlog=${item.backlog} ` +
          `batch=${batchSizeOverride || 'default'} providers=${providers.map((provider) => provider.provider).join(',')}`,
      );
        await runPriorityBriefings(level, {
          closeConnections: false,
          runUntilEmpty: false,
          maxBatches: config.categoryBriefingBatchesPerTick,
          categorySlug,
          batchSizeOverride,
        });
    } catch (error) {
      console.error(`Category briefing failed category=${categorySlug} level=${level}:`, error);
    }
  }
}

async function workerLoop(workerSlot, interval) {
  if (workerSlot > 1) {
    await sleep(Math.min(10, interval) * 1000 * (workerSlot - 1));
  }
  while (!shuttingDown) {
    await tick(workerSlot);
    await sleep(interval * 1000);
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
  const interval = pollIntervalSeconds();
  const concurrency = config.categoryBriefingConcurrency;
  const releasedClaims = await cleanupBriefingClaimsOlderThan(config.briefingStartupClaimCleanupMinutes);
  console.log(
    `Category briefing worker polling every ${interval}s; ` +
      `${config.categoryBriefingBatchesPerTick} batch(es) per active category/level; ` +
      `concurrency=${concurrency}; startup_claims_released=${releasedClaims}; worker=${WORKER_ID}`,
  );
  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1, interval)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
