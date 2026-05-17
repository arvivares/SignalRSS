import { pathToFileURL } from 'node:url';
import { runPriorityBriefings } from './generate-priority-briefings.js';

export function runP3Briefings(options) {
  return runPriorityBriefings('P3', options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runP3Briefings().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
