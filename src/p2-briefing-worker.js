import { runPriorityBriefingWorker } from './priority-briefing-worker.js';

runPriorityBriefingWorker('P2').catch((error) => {
  console.error(error);
  process.exit(1);
});
