import { pathToFileURL } from 'node:url';
import { runPriorityBriefings } from './generate-priority-briefings.js';

export function runP0Briefings(options) {
  return runPriorityBriefings('P0', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP0Briefings().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
