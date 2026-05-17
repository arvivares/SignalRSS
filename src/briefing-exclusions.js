import { config } from './config.js';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeLevel(value = '') {
  return String(value || '').trim().toUpperCase();
}

function parseRule(rule = '') {
  const separator = rule.includes(':') ? rule.indexOf(':') : rule.indexOf('=');
  if (separator < 1) return null;
  const category = normalize(rule.slice(0, separator));
  const level = normalizeLevel(rule.slice(separator + 1));
  if (!category || !level) return null;
  return { category, level };
}

const exclusionRules = config.categoryBriefingExcludeLevels
  .map(parseRule)
  .filter(Boolean);

export function isBriefingExcluded(categorySlug, level) {
  const category = normalize(categorySlug);
  const normalizedLevel = normalizeLevel(level);
  if (!category || !normalizedLevel) return false;
  return exclusionRules.some((rule) => (
    (rule.category === category || rule.category === '*')
    && (rule.level === normalizedLevel || rule.level === '*')
  ));
}

export function filterBriefingRows(rows = [], { categoryKey = 'category', levelKey = 'impact_level' } = {}) {
  return rows.filter((row) => !isBriefingExcluded(row[categoryKey], row[levelKey]));
}
