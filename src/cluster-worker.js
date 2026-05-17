import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb } from './db.js';
import { runClustering } from './cluster-articles.js';

let shuttingDown = false;

async function pollOnce() {
  try {
    await runClustering({
      closeConnections: false,
      runUntilEmpty: true,
    });
  } catch (error) {
    console.error(`Cluster worker failed: ${error.message}`);
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
  while (!shuttingDown) {
    await pollOnce();
    await sleep(config.clusterPollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
