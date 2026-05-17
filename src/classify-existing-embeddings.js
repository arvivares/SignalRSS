import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { cleanText, hashInput } from './text-utils.js';

function articleInput(article) {
  const parts = [
    `Title: ${cleanText(article.title)}`,
    article.summary ? `Summary: ${cleanText(article.summary).slice(0, config.classifierMaxSummaryChars)}` : '',
    article.content ? `Content: ${cleanText(article.content).slice(0, config.classifierMaxContentChars)}` : '',
  ].filter(Boolean);

  return parts.join('\n').slice(0, config.classifierMaxInputChars);
}

function articleGuardText(article) {
  return cleanText([article.title || '', article.summary || '', article.content || ''].join(' ')).toLowerCase();
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function minConfidenceForCategory(slug) {
  return config.classifierMinConfidenceByCategory[slug] ?? config.classifierMinConfidence;
}

function minMarginForCategory(slug) {
  return config.classifierMinMarginByCategory[slug] ?? config.classifierMinMargin;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasGuardTerm(searchText, term) {
  const normalizedTerm = cleanText(term).toLowerCase();
  if (/^[a-z0-9]+$/.test(normalizedTerm) && normalizedTerm.length <= 4) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}([^a-z0-9]|$)`).test(searchText);
  }
  return searchText.includes(normalizedTerm);
}

function isGuardedOut(category, searchText) {
  const guard = config.classifierCategoryGuards[category.slug];
  if (!guard?.enabled || !searchText) return false;

  if (guard.strictExcludesEnabled !== false) {
    const hasAlwaysExcludedTerm = (guard.alwaysExcludedTerms || []).some((term) => hasGuardTerm(searchText, term));
    if (hasAlwaysExcludedTerm) return true;
  }

  const hasRequiredTerm = (guard.requiredTerms || []).some((term) => hasGuardTerm(searchText, term));
  if (guard.requireRequiredTermsAlways && !hasRequiredTerm) return true;

  const requiredTermGroups = guard.requiredTermGroups || [];
  const hasAllRequiredTermGroups = requiredTermGroups.every((group) => (
    Array.isArray(group) && group.some((term) => hasGuardTerm(searchText, term))
  ));
  if (requiredTermGroups.length > 0 && !hasAllRequiredTermGroups) return true;

  const hasExcludedTerm = guard.excludedTerms.some((term) => hasGuardTerm(searchText, term));
  if (!hasExcludedTerm) return false;

  return !hasRequiredTerm;
}

function selectRankedCategories(categories, article) {
  const searchText = article ? articleGuardText(article) : '';
  const guardedOut = [];
  const eligibleCategories = [];

  for (const category of categories.filter((item) => Number.isFinite(item.confidence))) {
    if (isGuardedOut(category, searchText)) {
      guardedOut.push(category);
    } else {
      eligibleCategories.push(category);
    }
  }

  const sorted = eligibleCategories.sort((left, right) => right.confidence - left.confidence);
  const top = sorted[0] || null;
  const guardedTop = guardedOut.sort((left, right) => right.confidence - left.confidence)[0] || null;
  if (!top) {
    return {
      ranked: [],
      rejection: {
        topCategory: guardedTop,
        secondCategory: null,
        minConfidence: config.classifierMinConfidence,
        minMargin: config.classifierMinMargin,
        margin: null,
        reason: guardedTop ? 'top_category_guarded_out' : 'no_categories_available',
      },
    };
  }

  const second = sorted[1] || null;
  const margin = second ? top.confidence - second.confidence : top.confidence;
  const minConfidence = minConfidenceForCategory(top.slug);
  const minMargin = minMarginForCategory(top.slug);
  if (top.confidence < minConfidence || margin < minMargin) {
    return {
      ranked: [],
      rejection: {
        topCategory: top,
        secondCategory: second,
        minConfidence,
        minMargin,
        margin: Number(margin.toFixed(6)),
        reason: top.confidence < minConfidence ? 'top_category_below_min_confidence' : 'top_category_margin_too_low',
      },
    };
  }

  return {
    ranked: sorted
      .filter((category, index) => (
        index < config.classifierTopCategories && category.confidence >= minConfidenceForCategory(category.slug)
      ))
      .slice(0, config.classifierTopCategories),
    rejection: null,
  };
}

async function loadCategories() {
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, embedding
     FROM topic_categories
     WHERE active = TRUE
       AND embedding IS NOT NULL
       AND embedding_model = $1
     ORDER BY sort_order ASC, name ASC`,
    [config.embeddingModel],
  );
  return rows.map((category) => ({
    ...category,
    embedding: Array.isArray(category.embedding) ? category.embedding : JSON.parse(category.embedding),
  }));
}

async function loadArticles(limit) {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.summary, a.content, a.published_at, a.first_seen_at, a.updated_at,
            ae.embedding, ae.embedding_input_hash
       FROM articles a
       JOIN article_embeddings ae
         ON ae.article_id = a.id
        AND ae.embedding_model = $1
      WHERE NOT EXISTS (
        SELECT 1
        FROM article_classifications ac
        WHERE ac.article_id = a.id
          AND ac.model = $1
      )
        AND NOT EXISTS (
          SELECT 1
          FROM article_classification_rejections acr
          WHERE acr.article_id = a.id
            AND acr.model = $1
            AND acr.article_updated_at >= a.updated_at - INTERVAL '1 millisecond'
        )
        AND a.published_at >= NOW() - INTERVAL '7 days'
        AND a.published_at <= NOW()
      ORDER BY a.published_at DESC NULLS LAST, a.first_seen_at DESC
      LIMIT $2`,
    [config.embeddingModel, limit],
  );

  return rows
    .map((article) => {
      const expectedHash = hashInput(`${config.embeddingModel}|${articleInput(article)}`);
      if (article.embedding_input_hash !== expectedHash) return null;
      return {
        ...article,
        embedding: Array.isArray(article.embedding) ? article.embedding : JSON.parse(article.embedding),
      };
    })
    .filter(Boolean);
}

async function saveClassifications(article, rankedCategories, rejection = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM article_classifications WHERE article_id = $1 AND model = $2', [article.id, config.embeddingModel]);
    await client.query('DELETE FROM article_classification_rejections WHERE article_id = $1 AND model = $2', [article.id, config.embeddingModel]);

    if (rankedCategories.length === 0) {
      await client.query(
        `INSERT INTO article_classification_rejections (
           article_id, model, top_category_id, top_category_slug, top_confidence,
           second_category_slug, second_confidence, min_confidence, min_margin,
           confidence_margin, reason, article_updated_at, rejected_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (article_id, model) DO UPDATE SET
           top_category_id = EXCLUDED.top_category_id,
           top_category_slug = EXCLUDED.top_category_slug,
           top_confidence = EXCLUDED.top_confidence,
           second_category_slug = EXCLUDED.second_category_slug,
           second_confidence = EXCLUDED.second_confidence,
           min_confidence = EXCLUDED.min_confidence,
           min_margin = EXCLUDED.min_margin,
           confidence_margin = EXCLUDED.confidence_margin,
           reason = EXCLUDED.reason,
           article_updated_at = EXCLUDED.article_updated_at,
           rejected_at = NOW()`,
        [
          article.id,
          config.embeddingModel,
          rejection?.topCategory?.id || null,
          rejection?.topCategory?.slug || null,
          rejection?.topCategory?.confidence || null,
          rejection?.secondCategory?.slug || null,
          rejection?.secondCategory?.confidence || null,
          rejection?.minConfidence ?? config.classifierMinConfidence,
          rejection?.minMargin ?? config.classifierMinMargin,
          rejection?.margin ?? null,
          rejection?.reason || 'top_category_below_min_confidence',
          article.updated_at || article.first_seen_at,
        ],
      );
      await client.query('COMMIT');
      return 'rejected';
    }

    for (const [index, category] of rankedCategories.entries()) {
      await client.query(
        `INSERT INTO article_classifications (
           article_id, category_id, rank, confidence, method, model, classified_at
         )
         VALUES ($1, $2, $3, $4, 'existing_embedding_similarity', $5, NOW())`,
        [article.id, category.id, index + 1, category.confidence, config.embeddingModel],
      );
    }

    await client.query('COMMIT');
    return 'classified';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function classifyExistingEmbeddings({ closeConnections = true } = {}) {
  const categories = await loadCategories();
  if (categories.length === 0) throw new Error('No embedded categories found.');

  let considered = 0;
  let classified = 0;
  let rejected = 0;
  let batch = 0;

  for (;;) {
    batch += 1;
    const articles = await loadArticles(config.classifierBatchSize);
    if (articles.length === 0) break;

    for (const article of articles) {
      const result = selectRankedCategories(categories
        .map((category) => ({
          ...category,
          confidence: Number(dotProduct(article.embedding, category.embedding).toFixed(6)),
        })), article);

      const status = await saveClassifications(article, result.ranked, result.rejection);
      considered += 1;
      if (status === 'classified') classified += 1;
      else rejected += 1;
    }

    console.log(`Existing embedding batch ${batch}: classified ${classified}, rejected ${rejected}, considered ${considered}`);
  }

  console.log(`Existing embedding classification complete: classified ${classified}/${considered}, rejected ${rejected}`);
  if (closeConnections) await closeDb();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  classifyExistingEmbeddings().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
