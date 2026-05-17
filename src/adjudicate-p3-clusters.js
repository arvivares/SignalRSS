import { pathToFileURL } from 'node:url';
import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';

export function runP3ClusterAdjudication(options) {
  return runPriorityClusterAdjudication('P3', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP3ClusterAdjudication().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
