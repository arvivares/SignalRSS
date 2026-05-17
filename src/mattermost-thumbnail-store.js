import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fetchWithTimeout, responseTextWithLimit } from './http-utils.js';
import { safeErrorMessage } from './log-utils.js';
import { cleanText } from './text-utils.js';
import { elapsedMs, formatDuration, nowMs, sleep } from './timing-utils.js';

export function generatedThumbnailFilename(clusterId) {
  return `${clusterId}.png`;
}

export function generatedThumbnailPath(clusterId) {
  return path.join(config.mattermostGeneratedThumbnailDir, generatedThumbnailFilename(clusterId));
}

function generatedThumbnailUrlPath(clusterId) {
  return path.join(config.mattermostGeneratedThumbnailDir, `${clusterId}.url`);
}

export function generatedThumbnailUrl(clusterId) {
  const publicPath = config.mattermostGeneratedThumbnailPublicPath.replace(/\/$/, '');
  return `${config.publicBaseUrl.replace(/\/$/, '')}${publicPath}/${generatedThumbnailFilename(clusterId)}`;
}

const UPLOAD_RESPONSE_MAX_BYTES = 32 * 1024;

async function uploadGeneratedThumbnailOnce({ buffer, filename }) {
  if (!config.mattermostImageUploadEnabled) return '';
  if (config.mattermostImageUploadProvider !== 'litterbox') {
    console.warn(`Unsupported MATTERMOST_IMAGE_UPLOAD_PROVIDER: ${config.mattermostImageUploadProvider}`);
    return '';
  }

  try {
    const form = new FormData();
    form.set('reqtype', 'fileupload');
    form.set('time', config.mattermostImageUploadExpiration);
    form.set('fileToUpload', new Blob([buffer], { type: 'image/png' }), filename);

    const response = await fetchWithTimeout(config.mattermostImageUploadEndpoint, {
      method: 'POST',
      body: form,
      timeoutMs: 30000,
    });
    const body = cleanText(await responseTextWithLimit(response, { maxBytes: UPLOAD_RESPONSE_MAX_BYTES }));
    if (!response.ok || !/^https?:\/\//i.test(body)) {
      throw new Error(`HTTP ${response.status} ${body.slice(0, 180)}`);
    }

    return body;
  } catch (error) {
    throw new Error(`Generated thumbnail upload failed: ${safeErrorMessage(error)}`);
  }
}

async function uploadGeneratedThumbnail({ buffer, filename, timings = {} }) {
  if (!config.mattermostImageUploadEnabled) return '';

  const attempts = Math.max(1, config.mattermostImageUploadAttempts);
  timings.thumbnail_upload_attempts = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStart = nowMs();
    try {
      const uploadedUrl = await uploadGeneratedThumbnailOnce({ buffer, filename });
      const attemptMs = elapsedMs(attemptStart);
      timings.thumbnail_upload_attempts.push({
        attempt,
        ok: true,
        ms: attemptMs,
        url: uploadedUrl,
      });
      return uploadedUrl;
    } catch (error) {
      const attemptMs = elapsedMs(attemptStart);
      timings.thumbnail_upload_attempts.push({
        attempt,
        ok: false,
        ms: attemptMs,
        error: safeErrorMessage(error, 220),
      });

      if (attempt >= attempts) {
        console.warn(`Generated thumbnail upload failed after ${attempts} attempts: ${safeErrorMessage(error)}`);
        return '';
      }

      const backoffMs = config.mattermostImageUploadBackoffMs[attempt - 1] ?? 0;
      console.warn(`Generated thumbnail upload attempt ${attempt}/${attempts} failed in ${formatDuration(attemptMs)}; retrying in ${formatDuration(backoffMs)}: ${safeErrorMessage(error)}`);
      await sleep(backoffMs);
    }
  }

  return '';
}

export async function uploadGeneratedThumbnailWithTiming({ buffer, filename, timings }) {
  const uploadStart = nowMs();
  const uploadedUrl = await uploadGeneratedThumbnail({ buffer, filename, timings });
  timings.thumbnail_upload_ms = elapsedMs(uploadStart);
  if (Array.isArray(timings.thumbnail_upload_attempts)) {
    timings.thumbnail_upload_attempt_count = timings.thumbnail_upload_attempts.length;
  }
  if (!uploadedUrl) {
    timings.thumbnail_upload_failed = true;
  }

  return uploadedUrl;
}

export async function writeUploadedThumbnailUrl({ clusterId, uploadedUrl, timings }) {
  if (!uploadedUrl) return;
  const urlWriteStart = nowMs();
  await fs.writeFile(generatedThumbnailUrlPath(clusterId), uploadedUrl);
  timings.thumbnail_external_url_write_ms = elapsedMs(urlWriteStart);
}

async function uploadCachedGeneratedThumbnail({ clusterId, timings }) {
  try {
    const readStart = nowMs();
    const buffer = await fs.readFile(generatedThumbnailPath(clusterId));
    timings.thumbnail_local_read_ms = elapsedMs(readStart);
    const uploadedUrl = await uploadGeneratedThumbnailWithTiming({
      buffer,
      filename: generatedThumbnailFilename(clusterId),
      timings,
    });
    await writeUploadedThumbnailUrl({ clusterId, uploadedUrl, timings });
    return uploadedUrl;
  } catch {
    return '';
  }
}

export async function loadUploadedGeneratedThumbnailUrl(clusterId, timings = {}) {
  if (!config.mattermostImageUploadEnabled) return '';
  const urlPath = generatedThumbnailUrlPath(clusterId);
  try {
    const uploadedUrl = cleanText(await fs.readFile(urlPath, 'utf8'));
    if (/^https?:\/\//i.test(uploadedUrl)) {
      timings.thumbnail_external_url_cache_hit = true;
      return uploadedUrl;
    }
  } catch {
    // No cached external URL yet.
  }

  return uploadCachedGeneratedThumbnail({ clusterId, timings });
}
