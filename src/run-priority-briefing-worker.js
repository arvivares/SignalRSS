import { pathToFileURL } from 'node:url';
import { runPriorityBriefingWorker } from './priority-briefing-worker.js';
import { priorityLevelFromArg } from './run-priority-briefings.js';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPriorityBriefingWorker(priorityLevelFromArg()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
