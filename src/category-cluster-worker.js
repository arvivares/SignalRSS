import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb, waitForDb } from './db.js';
import { hasClusteringWork, runClustering } from './cluster-articles.js';
import { loadActiveCategorySlugs, withClusterCategory } from './category-runtime.js';

let shuttingDown = false;

async function tick() {
  const categories = await loadActiveCategorySlugs();
  console.log(`Category cluster worker: categories=${categories.join(',') || 'none'}`);

  for (const categorySlug of categories) {
    if (shuttingDown) return;
    try {
      withClusterCategory(categorySlug);
      if (!(await hasClusteringWork())) continue;
      await runClustering({ closeConnections: false, runUntilEmpty: false });
    } catch (error) {
      console.error(`Category cluster failed category=${categorySlug}:`, error);
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
  await waitForDb({ component: 'category-cluster-worker' });
  console.log(`Category cluster worker polling every ${config.clusterPollIntervalSeconds}s`);
  while (!shuttingDown) {
    await tick();
    await sleep(config.clusterPollIntervalSeconds * 1000);
  }
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
