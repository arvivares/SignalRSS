import { pathToFileURL } from 'node:url';
import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';

export function runP1ClusterAdjudication(options) {
  return runPriorityClusterAdjudication('P1', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP1ClusterAdjudication().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
