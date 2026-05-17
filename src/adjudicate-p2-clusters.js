import { pathToFileURL } from 'node:url';
import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';

export function runP2ClusterAdjudication(options) {
  return runPriorityClusterAdjudication('P2', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP2ClusterAdjudication().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
