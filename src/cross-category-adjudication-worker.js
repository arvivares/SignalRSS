import { config } from './config.js';
import { closeDb } from './db.js';
import { runCrossCategoryAdjudication } from './cross-category-adjudication.js';
import { sleep } from './timing-utils.js';

async function main() {
  console.log(`Cross-category adjudication worker polling every ${config.crossCategoryAdjudicationPollIntervalSeconds}s`);
  while (true) {
    try {
      await runCrossCategoryAdjudication({ closeConnections: false });
    } catch (error) {
      console.error('Cross-category adjudication failed:', error);
    }
    await sleep(config.crossCategoryAdjudicationPollIntervalSeconds * 1000);
  }
}

process.on('SIGTERM', async () => {
  await closeDb().catch(() => {});
  process.exit(0);
});

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
