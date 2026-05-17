import { config } from './config.js';
import { buildLinksText, buildMattermostText } from './mattermost-message.js';
import {
  generatedImageTargetDimensions,
  loadBestThumbnailMetadata,
  loadGeneratedThumbnailUrl,
} from './mattermost-thumbnail.js';
import { cleanText } from './text-utils.js';
import { elapsedMs, nowMs } from './timing-utils.js';

export async function mattermostPayload(briefing, destination, timings = {}) {
  const existingThumbnailStart = nowMs();
  const existingThumbnail = await loadBestThumbnailMetadata(briefing.cluster_id);
  timings.thumbnail_existing_lookup_ms = elapsedMs(existingThumbnailStart);
  if (existingThumbnail) {
    timings.thumbnail_existing_best_area = existingThumbnail.area || 0;
    timings.thumbnail_existing_best_width = existingThumbnail.width || null;
    timings.thumbnail_existing_best_height = existingThumbnail.height || null;
  }

  const targetDimensions = generatedImageTargetDimensions();
  timings.thumbnail_generated_target_area = targetDimensions.area;
  timings.thumbnail_generated_target_width = targetDimensions.width;
  timings.thumbnail_generated_target_height = targetDimensions.height;

  const existingThumbnailIsLargeEnough = Boolean(
    existingThumbnail?.url
    && existingThumbnail.area
    && targetDimensions.area
    && existingThumbnail.area >= targetDimensions.area
  );
  if (existingThumbnail?.url && !existingThumbnailIsLargeEnough) {
    timings.thumbnail_existing_rejected_reason = existingThumbnail.area
      ? 'smaller_than_generated_target'
      : 'unknown_dimensions';
  }

  const generatedThumbnailStart = nowMs();
  let thumbnailUrl = existingThumbnailIsLargeEnough ? existingThumbnail.url : '';
  if (!thumbnailUrl) {
    try {
      thumbnailUrl = await loadGeneratedThumbnailUrl(briefing, timings);
    } catch (error) {
      timings.thumbnail_generation_failed = true;
      timings.thumbnail_generation_error = cleanText(error.message).slice(0, 500);
      console.warn(`Generated thumbnail failed for cluster=${briefing.cluster_id}: ${error.message}`);
    } finally {
      timings.thumbnail_generated_total_ms = elapsedMs(generatedThumbnailStart);
    }
  }
  if (!thumbnailUrl && existingThumbnail?.url) {
    timings.thumbnail_fallback_to_small_existing = true;
    thumbnailUrl = existingThumbnail.url;
  }

  const payload = {
    text: buildMattermostText(briefing),
    username: config.mattermostUsername,
    icon_emoji: config.mattermostIconEmoji,
  };

  if (thumbnailUrl) {
    payload.attachments = [{ image_url: thumbnailUrl }];
  }

  payload.attachments = [
    ...(payload.attachments || []),
    { text: buildLinksText(briefing) },
  ];

  if (destination.channel) {
    payload.channel = destination.channel;
  }

  return { payload, thumbnailUrl };
}
