import { cleanText } from './text-utils.js';

function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const cleanUrl = url.trim().replaceAll('&amp;', '&');
  if (!/^https?:\/\//i.test(cleanUrl)) return '';
  return cleanUrl;
}

function numericDimension(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= 10000 ? Math.round(value) : null;
  }

  if (typeof value !== 'string') return null;

  const match = /^\s*(\d{1,5})(?:px)?\s*$/i.exec(value);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
}

function addImageCandidate(candidates, url, dimensions = {}) {
  const cleanUrl = normalizeImageUrl(url);
  if (!cleanUrl) return;
  candidates.push({
    url: cleanUrl,
    width: numericDimension(dimensions.width),
    height: numericDimension(dimensions.height),
  });
}

function htmlAttribute(tag, name) {
  const match = new RegExp(`\\b${name}=["']?([^"'\\s>]+)`, 'i').exec(tag);
  return match?.[1] || '';
}

function collectImageCandidatesFromValue(value, candidates = []) {
  if (!value) return candidates;

  if (typeof value === 'string') {
    const imageRegex = /<img\b[^>]*>/gi;
    let match = imageRegex.exec(value);
    while (match) {
      const tag = match[0];
      addImageCandidate(candidates, htmlAttribute(tag, 'src'), {
        width: htmlAttribute(tag, 'width'),
        height: htmlAttribute(tag, 'height'),
      });
      match = imageRegex.exec(value);
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageCandidatesFromValue(item, candidates);
    }
    return candidates;
  }

  if (typeof value !== 'object') return candidates;

  const url = value.url || value.href || value.$?.url || value.$?.href;
  const type = cleanText(value.type || value.$?.type || value.medium || value.$?.medium).toLowerCase();
  if (url && (!type || type.includes('image'))) {
    addImageCandidate(candidates, url, {
      width: value.width || value.$?.width,
      height: value.height || value.$?.height,
    });
  }

  for (const item of Object.values(value)) {
    collectImageCandidatesFromValue(item, candidates);
  }

  return candidates;
}

export function uniqueImageCandidates(rows) {
  const seen = new Set();
  const candidates = [];

  for (const row of rows) {
    collectImageCandidatesFromValue(row.raw_json, candidates);
    collectImageCandidatesFromValue(row.content, candidates);
    collectImageCandidatesFromValue(row.summary, candidates);
  }

  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function parsePngDimensions(buffer) {
  if (
    buffer.length >= 24
    && buffer[0] === 0x89
    && buffer.toString('ascii', 1, 4) === 'PNG'
    && buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return null;
}

function parseGifDimensions(buffer) {
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }
  return null;
}

function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;

    const isStartOfFrame = (
      marker >= 0xc0
      && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker)
    );
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

function parseWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }

  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

export function parseImageDimensions(buffer) {
  return parsePngDimensions(buffer)
    || parseJpegDimensions(buffer)
    || parseGifDimensions(buffer)
    || parseWebpDimensions(buffer);
}
