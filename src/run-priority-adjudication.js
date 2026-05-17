import { pathToFileURL } from 'node:url';
import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';
import { priorityLevelFromArg } from './run-priority-briefings.js';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPriorityClusterAdjudication(priorityLevelFromArg()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
