import { config } from './config.js';
import { runClusterMerge } from './merge-clusters.js';
import { sleep } from './timing-utils.js';

async function main() {
  console.log(`Cluster merge worker polling every ${config.clusterMergePollIntervalSeconds}s`);

  while (true) {
    try {
      await runClusterMerge({ closeConnections: false, runUntilStable: true });
    } catch (error) {
      console.error('Cluster merge failed:', error);
    }
    await sleep(config.clusterMergePollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
