import { cleanText, hashInput } from './text-utils.js';

export function normalizedStoryUrl(value = '') {
  try {
    const url = new URL(String(value).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function storyHashFromParts({ links = [], title = '' } = {}) {
  const urls = [...new Set(
    (Array.isArray(links) ? links : [])
      .map((link) => normalizedStoryUrl(link?.url))
      .filter(Boolean),
  )].sort();
  const basis = urls.length > 0
    ? urls.join('\n')
    : cleanText(title).toLowerCase();
  return hashInput(basis, 'md5');
}

export function briefingStoryHash(briefing = {}) {
  return briefing.story_hash || storyHashFromParts({
    links: briefing.links || [],
    title: briefing.title,
  });
}
