import { pathToFileURL } from 'node:url';
import { runPriorityBriefings } from './generate-priority-briefings.js';

export function runP2Briefings(options) {
  return runPriorityBriefings('P2', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP2Briefings().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
