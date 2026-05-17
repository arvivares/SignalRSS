import { pathToFileURL } from 'node:url';
import { runPriorityAdjudicationWorker } from './priority-adjudication-worker.js';
import { priorityLevelFromArg } from './run-priority-briefings.js';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPriorityAdjudicationWorker(priorityLevelFromArg());
}
