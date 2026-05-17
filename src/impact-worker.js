import { config } from './config.js';
import { runImpactScoring } from './score-impact.js';
import { sleep } from './timing-utils.js';

async function main() {
  console.log(`Impact worker polling every ${config.impactPollIntervalSeconds}s`);

  while (true) {
    try {
      await runImpactScoring({ closeConnections: false, runUntilEmpty: true });
    } catch (error) {
      console.error('Impact scoring failed:', error);
    }
    await sleep(config.impactPollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
