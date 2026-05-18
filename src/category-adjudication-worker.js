import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb, waitForDb } from './db.js';
import { hasPriorityAdjudicationWork, runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';
import { loadActiveCategorySlugs, withAdjudicationCategory } from './category-runtime.js';
import { PRIORITY_LEVELS } from './priority-config.js';

let shuttingDown = false;

function pollIntervalSeconds() {
  return Math.min(
    config.p0AdjudicationPollIntervalSeconds,
    config.p1AdjudicationPollIntervalSeconds,
    config.p2AdjudicationPollIntervalSeconds,
    config.p3AdjudicationPollIntervalSeconds,
  );
}

async function tick() {
  const categories = await loadActiveCategorySlugs();
  console.log(`Category adjudication worker: categories=${categories.join(',') || 'none'}`);

  for (const categorySlug of categories) {
    for (const level of PRIORITY_LEVELS) {
      if (shuttingDown) return;
      try {
        withAdjudicationCategory(level, categorySlug);
        if (!(await hasPriorityAdjudicationWork(level))) continue;
        await runPriorityClusterAdjudication(level, { closeConnections: false });
      } catch (error) {
        console.error(`Category adjudication failed category=${categorySlug} level=${level}:`, error);
      }
    }
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
  await waitForDb({ component: 'category-adjudication-worker' });
  const interval = pollIntervalSeconds();
  console.log(`Category adjudication worker polling every ${interval}s`);
  while (!shuttingDown) {
    await tick();
    await sleep(interval * 1000);
  }
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
