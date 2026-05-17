import fs from 'node:fs/promises';
import { config } from './config.js';
import { fetchWithTimeout, responseArrayBufferWithLimit } from './http-utils.js';
import { generateThumbnailImageWithTrace } from './mattermost-thumbnail-generation.js';
export { loadBestThumbnailMetadata } from './mattermost-thumbnail-metadata.js';
import {
  generatedThumbnailFilename,
  generatedThumbnailPath,
  generatedThumbnailUrl,
  loadUploadedGeneratedThumbnailUrl,
  uploadGeneratedThumbnailWithTiming,
  writeUploadedThumbnailUrl,
} from './mattermost-thumbnail-store.js';
import { elapsedMs, nowMs } from './timing-utils.js';

const THUMBNAIL_DOWNLOAD_MAX_BYTES = Number.parseInt(
  process.env.MATTERMOST_THUMBNAIL_DOWNLOAD_MAX_BYTES || `${12 * 1024 * 1024}`,
  10,
);

export function generatedImageTargetDimensions(size = config.mattermostGeneratedThumbnailSize) {
  const match = /^(\d+)x(\d+)$/i.exec(String(size || '').trim());
  if (!match) return { width: null, height: null, area: 0 };
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  return {
    width,
    height,
    area: width * height,
  };
}

async function imageResponseBuffer(image, timings) {
  if (image.b64_json) {
    const decodeStart = nowMs();
    const buffer = Buffer.from(image.b64_json, 'base64');
    timings.thumbnail_decode_ms = elapsedMs(decodeStart);
    return buffer;
  }

  if (image.url) {
    const downloadStart = nowMs();
    const imageResponse = await fetchWithTimeout(image.url);
    const buffer = imageResponse.ok
      ? Buffer.from(await responseArrayBufferWithLimit(imageResponse, { maxBytes: THUMBNAIL_DOWNLOAD_MAX_BYTES }))
      : null;
    timings.thumbnail_download_ms = elapsedMs(downloadStart);
    return buffer;
  }

  return null;
}

async function writeGeneratedThumbnail({ clusterId, buffer, timings }) {
  const filePath = generatedThumbnailPath(clusterId);
  const mkdirStart = nowMs();
  await fs.mkdir(config.mattermostGeneratedThumbnailDir, { recursive: true });
  timings.thumbnail_mkdir_ms = elapsedMs(mkdirStart);

  const writeStart = nowMs();
  await fs.writeFile(filePath, buffer);
  timings.thumbnail_local_write_ms = elapsedMs(writeStart);

  const uploadedUrl = await uploadGeneratedThumbnailWithTiming({
    buffer,
    filename: generatedThumbnailFilename(clusterId),
    timings,
  });
  await writeUploadedThumbnailUrl({ clusterId, uploadedUrl, timings });

  return uploadedUrl || generatedThumbnailUrl(clusterId);
}

export async function loadGeneratedThumbnailUrl(briefing, timings = {}) {
  if (!config.mattermostGenerateMissingThumbnails) return '';

  const filePath = generatedThumbnailPath(briefing.cluster_id);
  try {
    await fs.access(filePath);
    timings.thumbnail_local_cache_hit = true;
    return await loadUploadedGeneratedThumbnailUrl(briefing.cluster_id, timings)
      || generatedThumbnailUrl(briefing.cluster_id);
  } catch {
    // Missing cached image; generate it below.
  }

  const response = await generateThumbnailImageWithTrace({ briefing, timings });
  const buffer = await imageResponseBuffer(response.data?.[0] || {}, timings);
  if (!buffer?.length) return '';

  return writeGeneratedThumbnail({
    clusterId: briefing.cluster_id,
    buffer,
    timings,
  });
}
