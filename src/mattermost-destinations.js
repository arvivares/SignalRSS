import { config } from './config.js';
import { hashInput } from './text-utils.js';

export function destinationHash(webhookUrl, channel = '') {
  return hashInput(`${webhookUrl}\n${channel}`);
}

export function mattermostChannelForCategory(categorySlug) {
  return config.mattermostChannelsByCategory[categorySlug] || config.mattermostChannel || '';
}

export function mattermostDestinations() {
  const seen = new Set();
  return config.mattermostCategorySlugs
    .map((categorySlug) => categorySlug.trim())
    .filter(Boolean)
    .map((categorySlug) => {
      const channel = mattermostChannelForCategory(categorySlug);
      return {
        categorySlug,
        channel,
        hash: destinationHash(config.mattermostWebhookUrl, channel),
      };
    })
    .filter((destination) => {
      const key = `${destination.categorySlug}\n${destination.channel}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
