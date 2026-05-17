import { runPriorityClusterAdjudication } from './adjudicate-priority-clusters.js';
import { priorityAdjudicationSettings } from './priority-config.js';

export function runPriorityAdjudicationWorker(level) {
  const settings = priorityAdjudicationSettings(level);
  const intervalMs = settings.pollIntervalSeconds * 1000;

  async function tick() {
    try {
      await runPriorityClusterAdjudication(settings.level, { closeConnections: false });
    } catch (error) {
      console.error(`${settings.level} adjudication worker failed`, error);
    }
  }

  void tick();
  setInterval(tick, intervalMs);
}
