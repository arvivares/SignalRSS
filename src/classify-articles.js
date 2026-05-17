import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { observeOpenAIClient, shutdownLangfuseTracing, startLangfuseTracing } from './langfuse.js';
import { cleanText, hashInput } from './text-utils.js';

function normalizedSearchText(value = '') {
  return cleanText(value).toLowerCase();
}

function articleInput(article) {
  const parts = [
    `Title: ${cleanText(article.title)}`,
    article.summary ? `Summary: ${cleanText(article.summary).slice(0, config.classifierMaxSummaryChars)}` : '',
    article.content ? `Content: ${cleanText(article.content).slice(0, config.classifierMaxContentChars)}` : '',
  ].filter(Boolean);

  return parts.join('\n').slice(0, config.classifierMaxInputChars);
}

function articleGuardText(article) {
  return normalizedSearchText([
    article.title || '',
    article.summary || '',
    article.content || '',
  ].join(' '));
}

function categoryInput(category) {
  return `Technology news category: ${category.name}\nDefinition: ${category.description}`;
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function vectorLiteral(vector) {
  return `[${vector.join(',')}]`;
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
  const normalizedTerm = normalizedSearchText(term);
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

function selectRankedCategories(scoredCategories, article) {
  const searchText = article ? articleGuardText(article) : '';
  const guardedOut = [];
  const eligibleCategories = [];

  for (const category of scoredCategories) {
    if (isGuardedOut(category, searchText)) {
      guardedOut.push(category);
    } else {
      eligibleCategories.push(category);
    }
  }

  const ranked = eligibleCategories.sort((left, right) => right.confidence - left.confidence);
  const top = ranked[0] || null;
  const guardedTop = guardedOut.sort((left, right) => right.confidence - left.confidence)[0] || null;

  if (!top) {
    return {
      ranked: [],
      rejection: {
        reason: guardedTop ? 'top_category_guarded_out' : 'no_categories_available',
        topCategory: guardedTop,
        secondCategory: null,
        minConfidence: config.classifierMinConfidence,
        minMargin: config.classifierMinMargin,
        margin: null,
      },
    };
  }

  const second = ranked[1] || null;
  const minConfidence = minConfidenceForCategory(top.slug);
  const minMargin = minMarginForCategory(top.slug);
  const margin = second ? Number((top.confidence - second.confidence).toFixed(6)) : null;

  if (top.confidence < minConfidence) {
    return {
      ranked: [],
      rejection: {
        reason: 'top_category_below_min_confidence',
        topCategory: top,
        secondCategory: second,
        minConfidence,
        minMargin,
        margin,
      },
    };
  }

  if (second && minMargin > 0 && margin < minMargin) {
    return {
      ranked: [],
      rejection: {
        reason: 'top_category_below_min_margin',
        topCategory: top,
        secondCategory: second,
        minConfidence,
        minMargin,
        margin,
      },
    };
  }

  return {
    ranked: ranked
    .filter((category, index) => (
      index < config.classifierTopCategories && category.confidence >= minConfidenceForCategory(category.slug)
    ))
    .slice(0, config.classifierTopCategories),
    rejection: null,
  };
}

async function createEmbeddings(client, inputs) {
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: inputs,
  });

  return response.data
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
}

async function loadCategories() {
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, embedding, embedding_model, embedding_input_hash
     FROM topic_categories
     WHERE active = TRUE
     ORDER BY sort_order ASC, name ASC`,
  );
  return rows;
}

async function ensureCategoryEmbeddings(openai, categories) {
  const pending = categories.filter((category) => {
    const input = categoryInput(category);
    const inputHash = hashInput(`${config.embeddingModel}|${input}`);
    category.embeddingInput = input;
    category.expectedInputHash = inputHash;
    return (
      !category.embedding ||
      category.embedding_model !== config.embeddingModel ||
      category.embedding_input_hash !== inputHash
    );
  });

  if (pending.length > 0) {
    const embeddings = await createEmbeddings(openai, pending.map((category) => category.embeddingInput));
    await Promise.all(pending.map((category, index) => pool.query(
      `UPDATE topic_categories
       SET embedding = $2::jsonb,
           embedding_model = $3,
           embedding_dimensions = $4,
           embedding_input_hash = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        category.id,
        JSON.stringify(embeddings[index]),
        config.embeddingModel,
        embeddings[index].length,
        category.expectedInputHash,
      ],
    )));
  }

  return (await loadCategories()).map((category) => ({
    ...category,
    embedding: Array.isArray(category.embedding) ? category.embedding : JSON.parse(category.embedding),
  }));
}

async function loadUnclassifiedArticles() {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.summary, a.content, a.published_at, a.first_seen_at, a.updated_at
       FROM articles a
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
    [config.embeddingModel, config.classifierBatchSize],
  );
  return rows;
}

async function getOrCreateArticleEmbeddings(openai, articles) {
  if (articles.length === 0) return new Map();

  const inputsByArticle = new Map(articles.map((article) => {
    const input = articleInput(article);
    return [article.id, {
      input,
      inputHash: hashInput(`${config.embeddingModel}|${input}`),
    }];
  }));

  const { rows: existing } = await pool.query(
    `SELECT article_id, embedding, embedding_input_hash
     FROM article_embeddings
     WHERE article_id = ANY($1::uuid[])
       AND embedding_model = $2`,
    [articles.map((article) => article.id), config.embeddingModel],
  );

  const embeddingsByArticle = new Map();
  for (const row of existing) {
    const expected = inputsByArticle.get(row.article_id);
    if (expected?.inputHash === row.embedding_input_hash) {
      embeddingsByArticle.set(row.article_id, Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding));
    }
  }

  const missing = articles.filter((article) => !embeddingsByArticle.has(article.id));
  if (missing.length === 0) return embeddingsByArticle;

  const newEmbeddings = await createEmbeddings(openai, missing.map((article) => inputsByArticle.get(article.id).input));
  await Promise.all(missing.map((article, index) => {
    const embedding = newEmbeddings[index];
    const metadata = inputsByArticle.get(article.id);
    embeddingsByArticle.set(article.id, embedding);
    return pool.query(
      `INSERT INTO article_embeddings (
         article_id, embedding, embedding_vector, embedding_model, embedding_dimensions, embedding_input_hash, updated_at
       )
       VALUES ($1, $2::jsonb, $3::vector, $4, $5, $6, NOW())
       ON CONFLICT (article_id) DO UPDATE SET
         embedding = EXCLUDED.embedding,
         embedding_vector = EXCLUDED.embedding_vector,
         embedding_model = EXCLUDED.embedding_model,
         embedding_dimensions = EXCLUDED.embedding_dimensions,
         embedding_input_hash = EXCLUDED.embedding_input_hash,
         updated_at = NOW()`,
      [
        article.id,
        JSON.stringify(embedding),
        vectorLiteral(embedding),
        config.embeddingModel,
        embedding.length,
        metadata.inputHash,
      ],
    );
  }));

  return embeddingsByArticle;
}

async function saveClassifications(article, rankedCategories, rejection = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM article_classifications WHERE article_id = $1 AND model = $2',
      [article.id, config.embeddingModel],
    );
    await client.query(
      'DELETE FROM article_classification_rejections WHERE article_id = $1 AND model = $2',
      [article.id, config.embeddingModel],
    );

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
      return;
    }

    for (const [index, category] of rankedCategories.entries()) {
      await client.query(
        `INSERT INTO article_classifications (
           article_id, category_id, rank, confidence, method, model, classified_at
         )
         VALUES ($1, $2, $3, $4, 'embedding_similarity', $5, NOW())`,
        [article.id, category.id, index + 1, category.confidence, config.embeddingModel],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function classifyBatch(openai, categories) {
  const articles = await loadUnclassifiedArticles();
  const embeddingsByArticle = await getOrCreateArticleEmbeddings(openai, articles);
  let classified = 0;
  let rejected = 0;

  for (const article of articles) {
    const embedding = embeddingsByArticle.get(article.id);
    if (!embedding) continue;

    const result = selectRankedCategories(categories
      .map((category) => ({
        ...category,
        confidence: Number(dotProduct(embedding, category.embedding).toFixed(6)),
      })), article);

    await saveClassifications(article, result.ranked, result.rejection);
    if (result.ranked.length > 0) {
      classified += 1;
    } else {
      rejected += 1;
    }
  }

  return {
    considered: articles.length,
    classified,
    rejected,
  };
}

export async function runClassification({ closeConnections = true, runUntilEmpty = config.classifierRunUntilEmpty } = {}) {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required to classify articles with embeddings');
  }

  const tracing = startLangfuseTracing();
  const openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
    embeddingModel: config.embeddingModel,
    classifierBatchSize: config.classifierBatchSize,
  });
  const run = await pool.query(
    `INSERT INTO classification_runs (status, model)
     VALUES ('running', $1)
     RETURNING id`,
    [config.embeddingModel],
  );
  const runId = run.rows[0].id;

  try {
    const categories = await ensureCategoryEmbeddings(openai, await loadCategories());
    if (categories.length === 0) throw new Error('No active topic categories found. Run npm run seed:categories first.');

    let considered = 0;
    let classified = 0;
    let rejected = 0;
    let batch = 0;

    do {
      batch += 1;
      const result = await classifyBatch(openai, categories);
      considered += result.considered;
      classified += result.classified;
      rejected += result.rejected;
      console.log(`Batch ${batch}: classified ${result.classified}, rejected ${result.rejected}, considered ${result.considered}`);
      if (result.considered === 0) break;
    } while (runUntilEmpty);

    await pool.query(
      `UPDATE classification_runs
       SET status = 'ok',
         finished_at = NOW(),
         articles_considered = $2,
         articles_classified = $3
     WHERE id = $1`,
      [runId, considered, classified],
    );

    console.log(`Classified ${classified}/${considered} articles with ${config.embeddingModel}`);
    console.log(`Langfuse tracing ${tracing.enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    await pool.query(
      `UPDATE classification_runs
       SET status = 'failed',
           finished_at = NOW(),
           error = $2
       WHERE id = $1`,
      [runId, error.message],
    );
    throw error;
  } finally {
    if (closeConnections) {
      await shutdownLangfuseTracing();
      await closeDb();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClassification().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
