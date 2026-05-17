import { config } from './config.js';
import { pool } from './db.js';
import { fetchWithTimeout, responseArrayBufferWithLimit } from './http-utils.js';
import { parseImageDimensions, uniqueImageCandidates } from './image-utils.js';

const IMAGE_METADATA_MAX_BYTES = Number.parseInt(
  process.env.MATTERMOST_THUMBNAIL_METADATA_MAX_BYTES || `${512 * 1024}`,
  10,
);

async function loadImageMetadata(candidate) {
  try {
    let response = await fetchWithTimeout(candidate.url, { method: 'HEAD' });
    let contentType = response.headers.get('content-type')?.toLowerCase() || '';

    if (!response.ok || !contentType.startsWith('image/')) {
      response = await fetchWithTimeout(candidate.url, {
        method: 'GET',
        headers: {
          range: 'bytes=0-0',
        },
      });
      contentType = response.headers.get('content-type')?.toLowerCase() || '';
    }

    if (!response.ok || !contentType.startsWith('image/')) return null;

    if (candidate.width && candidate.height) {
      return {
        url: candidate.url,
        width: candidate.width,
        height: candidate.height,
        area: candidate.width * candidate.height,
      };
    }

    response = await fetchWithTimeout(candidate.url, {
      method: 'GET',
      headers: {
        range: 'bytes=0-524287',
      },
    });

    if (!response.ok) return { url: candidate.url, width: null, height: null, area: 0 };
    const dimensions = parseImageDimensions(Buffer.from(
      await responseArrayBufferWithLimit(response, { maxBytes: IMAGE_METADATA_MAX_BYTES }),
    ));
    return {
      url: candidate.url,
      width: dimensions?.width || null,
      height: dimensions?.height || null,
      area: dimensions?.width && dimensions?.height ? dimensions.width * dimensions.height : 0,
    };
  } catch {
    return null;
  }
}

export async function loadBestThumbnailMetadata(clusterId) {
  const { rows } = await pool.query(`
    SELECT
      a.raw_json,
      a.content,
      a.summary
    FROM cluster_articles ca
    JOIN articles a ON a.id = ca.article_id
    WHERE ca.cluster_id = $1
    ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
  `, [clusterId]);

  const candidates = uniqueImageCandidates(rows).slice(0, config.mattermostThumbnailMaxCandidates);
  let best = null;

  for (const candidate of candidates) {
    const metadata = await loadImageMetadata(candidate);
    if (!metadata) continue;

    if (!best || metadata.area > best.area) {
      best = metadata;
    }
  }

  return best;
}
