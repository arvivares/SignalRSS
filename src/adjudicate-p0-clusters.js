import { pathToFileURL } from 'node:url';
import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';

export function runP0ClusterAdjudication(options) {
  return runPriorityClusterAdjudication('P0', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP0ClusterAdjudication().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
