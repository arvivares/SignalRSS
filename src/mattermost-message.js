import { config } from './config.js';
import { cleanText } from './text-utils.js';

function formatDate(value) {
  if (!value) return 'sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'sin fecha';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function sourceLabel(link) {
  if (link.source) return link.source;
  try {
    return new URL(link.url).hostname.replace(/^www\./, '');
  } catch {
    return 'fuente';
  }
}

function markdownLink(title, url) {
  const safeTitle = cleanText(title || url).replaceAll('[', '(').replaceAll(']', ')');
  return `[${safeTitle}](${url})`;
}

function detailUrl(level, clusterId) {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/${level.toLowerCase()}/${clusterId}`;
}

export function buildLinksText(briefing) {
  const links = Array.isArray(briefing.links) ? briefing.links : [];
  const linkLines = links.length
    ? links.map((link) => `- ${markdownLink(link.title, link.url)} - ${sourceLabel(link)}`).join('\n')
    : '- Sin links disponibles';

  return [
    '**Links**',
    linkLines,
    '',
    markdownLink('Ver JSON del brief en SignalRSS', detailUrl(briefing.impact_level, briefing.cluster_id)),
  ].join('\n');
}

export function buildMattermostText(briefing) {
  return [
    `### ${cleanText(briefing.title)}`,
    `**Impacto:** ${briefing.impact_score}/100 - ${briefing.impact_category}`,
    `**Publicado:** ${formatDate(briefing.latest_published_at)}`,
    '',
    cleanText(briefing.summary),
  ].join('\n');
}
