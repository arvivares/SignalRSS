import { runPriorityBriefingWorker } from './priority-briefing-worker.js';

runPriorityBriefingWorker('P3').catch((error) => {
  console.error(error);
  process.exit(1);
});
