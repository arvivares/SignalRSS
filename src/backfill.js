import { closeDb } from './db.js';
import { config } from './config.js';
import { cutoffDate, fetchAndStoreFeed, loadFeeds } from './ingest.js';

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const results = [];

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}

async function main() {
  const since = cutoffDate(config.ingestWindowDays);
  const until = new Date();
  const feeds = await loadFeeds({ all: true });
  let ok = 0;
  let failed = 0;
  let inserted = 0;
  let linked = 0;

  console.log(`Backfilling ${feeds.length} feeds since ${since.toISOString()}`);

  await runWithConcurrency(feeds, config.backfillConcurrency, async (feed, index) => {
    const result = await fetchAndStoreFeed(feed, { since, until });
    if (result.status === 'ok') {
      ok += 1;
      inserted += result.itemsInserted;
      linked += result.itemsLinked;
      console.log(`${index + 1}/${feeds.length} OK ${feed.name}: inserted=${result.itemsInserted} linked=${result.itemsLinked}`);
    } else {
      failed += 1;
      console.error(`${index + 1}/${feeds.length} FAIL ${feed.name}: ${result.error}`);
    }
    return result;
  });

  console.log(`Backfill complete: ok=${ok} failed=${failed} inserted=${inserted} linked=${linked}`);
  await closeDb();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
