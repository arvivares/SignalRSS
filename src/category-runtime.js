import { config } from './config.js';
import { pool } from './db.js';

function parseList(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function applyShard(categories, {
  shardIndex = process.env.CATEGORY_WORKER_SHARD_INDEX,
  shardTotal = process.env.CATEGORY_WORKER_SHARD_TOTAL,
} = {}) {
  const total = parseInteger(shardTotal, 1);
  if (total <= 1) return categories;

  const index = parseInteger(shardIndex, 0);
  if (index < 0 || index >= total) {
    throw new Error(`Invalid category worker shard: index=${index}, total=${total}`);
  }

  return categories.filter((_, itemIndex) => itemIndex % total === index);
}

export async function loadActiveCategorySlugs({
  include = process.env.CATEGORY_WORKER_INCLUDE_SLUGS || '',
  exclude = process.env.CATEGORY_WORKER_EXCLUDE_SLUGS || '',
  shardIndex = process.env.CATEGORY_WORKER_SHARD_INDEX,
  shardTotal = process.env.CATEGORY_WORKER_SHARD_TOTAL,
} = {}) {
  const includeSlugs = new Set(parseList(include));
  const excludeSlugs = new Set(parseList(exclude));
  const { rows } = await pool.query(
    `SELECT slug
     FROM topic_categories
     WHERE active = TRUE
     ORDER BY sort_order ASC, name ASC`,
  );

  const categories = rows
    .map((row) => row.slug)
    .filter((slug) => includeSlugs.size === 0 || includeSlugs.has(slug))
    .filter((slug) => !excludeSlugs.has(slug));

  return applyShard(categories, { shardIndex, shardTotal });
}

export function withClusterCategory(categorySlug) {
  config.clusterCategorySlug = categorySlug;
}

export function withImpactCategory(categorySlug) {
  config.impactCategorySlug = categorySlug;
}

export function withAdjudicationCategory(level, categorySlug) {
  const normalized = String(level || '').toUpperCase();
  config[`${normalized.toLowerCase()}AdjudicationCategorySlug`] = categorySlug;
}

export function withBriefingCategory(level, categorySlug) {
  const normalized = String(level || '').toUpperCase();
  config[`${normalized.toLowerCase()}BriefingCategorySlug`] = categorySlug;
}
