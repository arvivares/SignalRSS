import { pathToFileURL } from 'node:url';
import { runPriorityBriefings } from './generate-priority-briefings.js';

export function runP1Briefings(options) {
  return runPriorityBriefings('P1', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP1Briefings().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
