import { config } from './config.js';
import { runMattermostNotifications } from './mattermost-notifier.js';
import { sleep } from './timing-utils.js';

async function main() {
  console.log(`Mattermost worker polling every ${config.mattermostPollIntervalSeconds}s`);

  while (true) {
    try {
      await runMattermostNotifications({ closeConnections: false });
    } catch (error) {
      console.error('Mattermost notification worker failed:', error);
    }
    await sleep(config.mattermostPollIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error('Mattermost worker crashed:', error);
  process.exit(1);
});
