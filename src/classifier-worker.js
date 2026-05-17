import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb } from './db.js';
import { shutdownLangfuseTracing } from './langfuse.js';
import { runClassification } from './classify-articles.js';

let shuttingDown = false;

async function pollOnce() {
  try {
    await runClassification({
      closeConnections: false,
      runUntilEmpty: true,
    });
  } catch (error) {
    console.error(`Classifier worker failed: ${error.message}`);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownLangfuseTracing().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  while (!shuttingDown) {
    await pollOnce();
    await sleep(config.classifierPollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
