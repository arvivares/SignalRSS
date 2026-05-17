import { config } from './config.js';
import { closeDb } from './db.js';
import { mattermostDestinations } from './mattermost-destinations.js';
import {
  claimNotification,
  loadPendingBriefings,
  markExistingBriefingsSkipped,
  saveNotification,
  savePostedNotification,
} from './mattermost-notification-store.js';
import { mattermostPayload } from './mattermost-payload.js';
import { shutdownLangfuseTracing } from './langfuse.js';
import { elapsedMs, nowMs } from './timing-utils.js';

function normalizeLevels(levels) {
  const allowed = new Set(['P0', 'P1', 'P2', 'P3']);
  return levels.filter((level) => allowed.has(level));
}

async function postToMattermost(briefing, destination) {
  const timings = {};
  const flowStart = nowMs();
  const payloadStart = nowMs();
  const { payload, thumbnailUrl } = await mattermostPayload(briefing, destination, timings);
  timings.payload_build_ms = elapsedMs(payloadStart);

  const postStart = nowMs();
  const response = await fetch(config.mattermostWebhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  timings.mattermost_post_ms = elapsedMs(postStart);

  const responseReadStart = nowMs();
  const body = await response.text();
  timings.mattermost_response_read_ms = elapsedMs(responseReadStart);
  timings.total_wall_ms = elapsedMs(flowStart);

  console.log([
    `Mattermost flow cluster=${briefing.cluster_id}`,
    `category=${briefing.category_slug || destination.categorySlug}`,
    `channel=${destination.channel || 'default'}`,
    `status=${response.status}`,
    `thumbnail=${thumbnailUrl || 'none'}`,
    `timings=${JSON.stringify(timings)}`,
  ].join(' '));

  return {
    ok: response.ok,
    status: response.status,
    body: body.slice(0, 1000),
    payload: {
      ...payload,
      signalrss_diagnostics: {
        timings_ms: timings,
      },
    },
    thumbnailUrl,
    timings,
  };
}

export async function runMattermostNotifications({ closeConnections = true } = {}) {
  if (!config.mattermostEnabled) {
    console.log('Mattermost notifications disabled');
    if (closeConnections) await closeDb();
    return { posted: 0, failed: 0, skippedExisting: 0 };
  }

  if (!config.mattermostWebhookUrl) {
    console.log('MATTERMOST_WEBHOOK_URL is not configured; skipping notifications');
    if (closeConnections) await closeDb();
    return { posted: 0, failed: 0, skippedExisting: 0 };
  }

  const levels = normalizeLevels(config.mattermostLevels);
  if (levels.length === 0) {
    throw new Error('MATTERMOST_LEVELS must include at least one of P0, P1, P2, or P3');
  }

  let skippedExisting = 0;
  let posted = 0;
  let failed = 0;
  const destinations = mattermostDestinations();
  if (destinations.length === 0) {
    console.log('MATTERMOST_CATEGORY_SLUGS is empty; skipping notifications');
    if (closeConnections) await closeDb();
    return { posted: 0, failed: 0, skippedExisting: 0 };
  }

  try {
    for (const destination of destinations) {
      if (!config.mattermostNotifyExisting) {
        const skippedForDestination = await markExistingBriefingsSkipped({ destination, levels });
        skippedExisting += skippedForDestination;
        if (skippedForDestination > 0) {
          console.log(`Marked ${skippedForDestination} existing Mattermost briefings as skipped for ${destination.categorySlug}`);
        }
      }

      const briefings = await loadPendingBriefings({ destination, levels });
      for (const briefing of briefings) {
        const claimed = await claimNotification({ briefing, hash: destination.hash });
        if (!claimed) continue;

        try {
          const result = await postToMattermost(briefing, destination);
          if (result.ok) {
            const savedStatus = await savePostedNotification({ briefing, hash: destination.hash, result });
            if (savedStatus === 'posted') {
              posted += 1;
            } else {
              skippedExisting += 1;
            }
            continue;
          }

          await saveNotification({
            briefing,
            hash: destination.hash,
            status: 'failed',
            responseStatus: result.status,
            responseBody: result.body,
            error: `Mattermost returned HTTP ${result.status}`,
            payload: result.payload,
            thumbnailUrl: result.thumbnailUrl,
          });
          failed += 1;
        } catch (error) {
          await saveNotification({
            briefing,
            hash: destination.hash,
            status: 'failed',
            error: error.message,
          });
          failed += 1;
        }
      }
    }

    console.log(`Mattermost notifications: posted ${posted}, failed ${failed}, skipped_existing ${skippedExisting}`);
    return { posted, failed, skippedExisting };
  } finally {
    if (closeConnections) {
      await shutdownLangfuseTracing().catch(() => {});
      await closeDb();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMattermostNotifications().catch(async (error) => {
    console.error('Mattermost notification run failed:', error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
