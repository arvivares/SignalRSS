import { runPriorityBriefings } from './generate-priority-briefings.js';
import { priorityBriefingSettings } from './priority-config.js';
import { sleep } from './timing-utils.js';

export async function runPriorityBriefingWorker(level) {
  const settings = priorityBriefingSettings(level);
  console.log(`${settings.level} briefing worker polling every ${settings.pollIntervalSeconds}s`);

  while (true) {
    try {
      await runPriorityBriefings(settings.level, { closeConnections: false, runUntilEmpty: true });
    } catch (error) {
      console.error(`${settings.level} briefing generation failed:`, error);
    }
    await sleep(settings.pollIntervalSeconds * 1000);
  }
}
