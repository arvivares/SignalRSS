import { runPriorityBriefingWorker } from './priority-briefing-worker.js';

runPriorityBriefingWorker('P1').catch((error) => {
  console.error(error);
  process.exit(1);
});
