import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDb, waitForDb } from './db.js';
import { quarantineLowQualityFeeds } from './feed-quarantine.js';
import { cutoffDate, fetchAndStoreFeed, loadFeeds } from './ingest.js';

async function pollOnce() {
  const quarantine = await quarantineLowQualityFeeds();
  if (quarantine.disabled > 0) {
    console.log(`Auto-quarantined ${quarantine.disabled} low-quality feeds`);
  }

  const feeds = await loadFeeds({ limit: config.workerBatchSize });
  const since = cutoffDate(config.ingestWindowDays);
  const until = new Date();

  for (const feed of feeds) {
    const result = await fetchAndStoreFeed(feed, { since, until });
    const message = `${feed.name}: found=${result.itemsFound} inserted=${result.itemsInserted} linked=${result.itemsLinked}`;
    if (result.status === 'ok') console.log(`Fetched ${message}`);
    else console.error(`Failed ${feed.name}: ${result.error}`);
  }
}

async function main() {
  await waitForDb({ component: 'worker' });
  while (true) {
    await pollOnce();
    await sleep(config.workerPollIntervalSeconds * 1000);
  }
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
