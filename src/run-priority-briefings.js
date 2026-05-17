import { pathToFileURL } from 'node:url';
import { runPriorityBriefings } from './generate-priority-briefings.js';

export function priorityLevelFromArg(fallback = 'P0') {
  return String(process.argv[2] || fallback).toUpperCase();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPriorityBriefings(priorityLevelFromArg()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
