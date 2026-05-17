import { config } from './config.js';

export const PRIORITY_LEVELS = ['P0', 'P1', 'P2', 'P3'];

const levelRank = new Map(PRIORITY_LEVELS.map((level, index) => [level, index]));

function lower(level) {
  return level.toLowerCase();
}

function requirePriorityLevel(level) {
  const normalized = String(level || '').toUpperCase();
  if (!levelRank.has(normalized)) {
    throw new Error(`Unsupported priority level: ${level}`);
  }
  return normalized;
}

function configKey(level, suffix) {
  return `${lower(level)}${suffix}`;
}

function envPrefix(level) {
  return lower(level);
}

function traceCategory(categorySlug) {
  return categorySlug || 'all-categories';
}

function categoryEnvPrefix(categorySlug = '') {
  return String(categorySlug).trim().replace(/-/g, '_').toUpperCase();
}

function categoryNumberEnv(categorySlug, suffix, fallback) {
  const prefix = categoryEnvPrefix(categorySlug);
  if (!prefix) return fallback;
  const value = Number(process.env[`${prefix}_${suffix}`]);
  return Number.isFinite(value) ? value : fallback;
}

export function priorityBriefingSettings(level, { categorySlug: categorySlugOverride } = {}) {
  const normalized = requirePriorityLevel(level);
  const prefix = envPrefix(normalized);
  const categorySlug = categorySlugOverride ?? config[configKey(normalized, 'BriefingCategorySlug')];
  const versionSuffix = config.briefingVersionSuffix || 'es-v1';
  return {
    level: normalized,
    lowerLevel: prefix,
    version: `${prefix}-${versionSuffix}`,
    locale: 'es',
    briefingType: `${prefix}-cluster-briefing`,
    schemaName: `${prefix}_spanish_briefings`,
    traceName: `signalrss-${traceCategory(categorySlug)}-${prefix}-briefing-generator`,
    component: `${traceCategory(categorySlug)}-${prefix}-briefing-generator`,
    model: config[configKey(normalized, 'BriefingModel')],
    batchSize: config[configKey(normalized, 'BriefingBatchSize')],
    pollIntervalSeconds: config[configKey(normalized, 'BriefingPollIntervalSeconds')],
    windowHours: config[configKey(normalized, 'BriefingWindowHours')],
    minPublishedAt: config.briefingMinPublishedAt,
    categorySlug,
    runUntilEmpty: config[configKey(normalized, 'BriefingRunUntilEmpty')],
    queryLimitMultiplier: normalized === 'P0' ? 20 : 100,
    minQueryLimit: normalized === 'P0' ? 200 : 2500,
  };
}

function adjudicationThresholds(level, categorySlug) {
  if (level === 'P0') {
    return {
      p0_p0: categoryNumberEnv(
        categorySlug,
        'P0_ADJUDICATION_MIN_CENTROID_SIMILARITY',
        config.p0AdjudicationMinCentroidSimilarity,
      ),
    };
  }

  const prefix = lower(level);
  const rank = levelRank.get(level);
  const thresholds = {
    [`${prefix}_${prefix}`]: config[configKey(level, `Adjudication${level}${level}MinCentroidSimilarity`)],
  };

  for (const target of PRIORITY_LEVELS.slice(0, rank)) {
    thresholds[`${prefix}_${lower(target)}`] = config[configKey(level, `Adjudication${level}${target}MinCentroidSimilarity`)];
  }

  return thresholds;
}

function conservativePrompt(level) {
  if (level === 'P0') {
    return 'Be conservative with military, policy, and business themes: related topic is not enough.';
  }
  if (level === 'P1') {
    return 'Be conservative with broad themes like AI investment, governance, military AI, cloud, and Anthropic/OpenAI business activity.';
  }
  return 'Be conservative with broad themes like AI agents, AI governance, productivity tools, model performance, and market adoption.';
}

export function priorityAdjudicationSettings(level) {
  const normalized = requirePriorityLevel(level);
  const prefix = envPrefix(normalized);
  const rank = levelRank.get(normalized);
  const compareToLevels = PRIORITY_LEVELS.slice(0, rank);
  const categorySlug = config[configKey(normalized, 'AdjudicationCategorySlug')];
  return {
    level: normalized,
    lowerLevel: prefix,
    version: `${prefix}-merge-adjudication-v1`,
    tableName: `${prefix}_cluster_merge_adjudications`,
    schemaName: `${prefix}_cluster_merge_adjudications`,
    traceName: `signalrss-${traceCategory(categorySlug)}-${prefix}-cluster-adjudicator`,
    component: `${traceCategory(categorySlug)}-${prefix}-cluster-adjudicator`,
    model: config[configKey(normalized, 'AdjudicationModel')],
    batchSize: config[configKey(normalized, 'AdjudicationBatchSize')],
    pollIntervalSeconds: config[configKey(normalized, 'AdjudicationPollIntervalSeconds')],
    windowHours: config[configKey(normalized, 'AdjudicationWindowHours')],
    categorySlug,
    maxCentroidSimilarity: config[configKey(normalized, 'AdjudicationMaxCentroidSimilarity')],
    minArticleSimilarity: config[configKey(normalized, 'AdjudicationMinArticleSimilarity')],
    mergeConfidence: categoryNumberEnv(
      categorySlug,
      `${normalized}_ADJUDICATION_MERGE_CONFIDENCE`,
      config[configKey(normalized, 'AdjudicationMergeConfidence')],
    ),
    compareToLevels,
    loadedLevels: [...compareToLevels, normalized],
    thresholds: adjudicationThresholds(normalized, categorySlug),
    relaxedCandidateBaselineSimilarity: config.p0AdjudicationMinCentroidSimilarity,
    minStrongTokenOverlap: categoryNumberEnv(
      categorySlug,
      'PRIORITY_ADJUDICATION_MIN_STRONG_TOKEN_OVERLAP',
      config.priorityAdjudicationMinStrongTokenOverlap,
    ),
    conservativePrompt: conservativePrompt(normalized),
  };
}

export function pairTypeFor(level, targetLevel) {
  return `${lower(level)}_${lower(targetLevel)}`;
}
