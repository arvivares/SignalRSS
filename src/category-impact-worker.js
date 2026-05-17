import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb } from './db.js';
import { runImpactScoring } from './score-impact.js';
import { withImpactCategory } from './category-runtime.js';

let shuttingDown = false;

async function tick() {
  if (shuttingDown) return;
  try {
    await runImpactScoring({
      closeConnections: false,
      runUntilEmpty: false,
      maxBatches: config.impactBatchesPerTick,
    });
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
      `${config.impactBatchesPerTick} batch(es) per tick`,
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
