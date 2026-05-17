import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { chooseTarget, mergePair } from './merge-clusters.js';
import { observeOpenAIClient, shutdownLangfuseTracing, startLangfuseTracing } from './langfuse.js';
import { cleanText, hashInput } from './text-utils.js';

const DECISIONS = new Set(['same_story', 'related_but_distinct', 'distinct', 'insufficient_evidence']);
const IMPACT_PRIORITY = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);
const CATEGORY_PRIORITY = new Map([
  ['artificial-intelligence', 0],
  ['cybersecurity', 1],
]);
const TOKEN_STOPWORDS = new Set([
  'about',
  'after',
  'against',
  'amid',
  'from',
  'into',
  'more',
  'news',
  'over',
  'said',
  'says',
  'than',
  'that',
  'their',
  'this',
  'with',
  'your',
  'artificial',
  'intelligence',
  'cybersecurity',
  'security',
  'cloud',
  'infrastructure',
  'semiconductor',
  'semiconductors',
  'chips',
  'technology',
  'tech',
]);

function parseEmbedding(value) {
  return Array.isArray(value) ? value : JSON.parse(value);
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function hostFromUrl(value = '') {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function tokensForText(value = '') {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token))
    .slice(0, 80);
}

function clusterTokens(cluster) {
  const text = [
    cluster.title,
    ...cluster.articles.slice(0, 5).flatMap((article) => [article.title, article.summary]),
  ].join(' ');
  return new Set(tokensForText(text));
}

function tokenOverlap(left, right) {
  let overlap = 0;
  const smaller = left.tokens.size <= right.tokens.size ? left.tokens : right.tokens;
  const larger = left.tokens.size <= right.tokens.size ? right.tokens : left.tokens;
  for (const token of smaller) {
    if (larger.has(token)) overlap += 1;
    if (overlap >= config.crossCategoryAdjudicationMinTokenOverlap) break;
  }
  return overlap;
}

function canonicalPairKey(left, right) {
  return [left.id, right.id].sort((leftId, rightId) => leftId - rightId).join(':');
}

function buildTokenIndex(clusters) {
  const rawIndex = new Map();
  for (const cluster of clusters) {
    for (const token of cluster.tokens) {
      if (!rawIndex.has(token)) rawIndex.set(token, []);
      rawIndex.get(token).push(cluster);
    }
  }

  const maxFanout = Math.max(1, Number(config.crossCategoryAdjudicationMaxTokenFanout) || 1);
  const tokenIndex = new Map();
  let skippedTokens = 0;
  let indexedPostings = 0;

  for (const [token, tokenClusters] of rawIndex.entries()) {
    if (tokenClusters.length > maxFanout) {
      skippedTokens += 1;
      continue;
    }
    tokenIndex.set(token, tokenClusters);
    indexedPostings += tokenClusters.length;
  }

  return {
    tokenIndex,
    indexedTokens: tokenIndex.size,
    skippedTokens,
    indexedPostings,
  };
}

function buildVectorNeighbors(clusters) {
  const neighbors = new Map();
  for (const cluster of clusters) {
    neighbors.set(cluster.id, new Set(cluster.vector_neighbor_ids || []));
  }
  return neighbors;
}

function candidatePairsFromTokenIndex(clusters) {
  const seeds = clusters.filter((cluster) => cluster.is_seed);
  const {
    tokenIndex,
    indexedTokens,
    skippedTokens,
    indexedPostings,
  } = buildTokenIndex(clusters);
  const vectorNeighbors = buildVectorNeighbors(clusters);
  const pairs = [];
  const seenPairs = new Set();

  for (const seed of seeds) {
    for (const token of seed.tokens) {
      const tokenClusters = tokenIndex.get(token);
      if (!tokenClusters) continue;

      for (const other of tokenClusters) {
        if (seed.id === other.id || seed.category_id === other.category_id) continue;
        if (!vectorNeighbors.get(seed.id)?.has(other.id) && !vectorNeighbors.get(other.id)?.has(seed.id)) continue;
        const key = canonicalPairKey(seed, other);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        pairs.push(seed.id < other.id ? [seed, other] : [other, seed]);
      }
    }
  }

  return {
    pairs,
    seedClusters: seeds.length,
    indexedTokens,
    skippedTokens,
    indexedPostings,
  };
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('');
}

function normalizeDecision(value) {
  return DECISIONS.has(value) ? value : 'insufficient_evidence';
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, confidence));
}

function impactPriority(cluster) {
  return IMPACT_PRIORITY.get(String(cluster.impact_level || '').toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
}

function categoryPriority(cluster) {
  return CATEGORY_PRIORITY.get(cluster.category_slug) ?? Number.MAX_SAFE_INTEGER;
}

function chooseCrossCategoryTarget(left, right) {
  const leftImpactPriority = impactPriority(left);
  const rightImpactPriority = impactPriority(right);
  if (leftImpactPriority !== rightImpactPriority) {
    return leftImpactPriority < rightImpactPriority ? [left, right] : [right, left];
  }

  const leftArticles = Number(left.article_count || 0);
  const rightArticles = Number(right.article_count || 0);
  if (leftArticles !== rightArticles) {
    return leftArticles > rightArticles ? [left, right] : [right, left];
  }

  const leftCategoryPriority = categoryPriority(left);
  const rightCategoryPriority = categoryPriority(right);
  if (leftCategoryPriority !== rightCategoryPriority) {
    return leftCategoryPriority < rightCategoryPriority ? [left, right] : [right, left];
  }

  return chooseTarget(left, right);
}

function pairType(left, right) {
  return `${left.category_slug}:${left.impact_level}_${right.category_slug}:${right.impact_level}`;
}

function pairKey(left, right) {
  return `cross:${[left.id, right.id].sort().join(':')}`;
}

function clusterInput(cluster) {
  return {
    cluster_id: cluster.id,
    category_slug: cluster.category_slug,
    impact_level: cluster.impact_level,
    impact_score: Number(cluster.impact_score || 0),
    impact_category: cluster.impact_category,
    title: cleanText(cluster.title).slice(0, 260),
    article_count: Number(cluster.article_count || 0),
    latest_published_at: cluster.latest_published_at,
    articles: cluster.articles.slice(0, 5).map((article) => ({
      title: cleanText(article.title).slice(0, 260),
      source: article.source,
      published_at: article.published_at,
      summary: cleanText(article.summary).slice(0, 350),
    })),
  };
}

function candidateInput(candidate) {
  return {
    candidate_id: candidate.id,
    pair_type: candidate.pair_type,
    token_overlap: candidate.token_overlap,
    centroid_similarity: candidate.centroid_similarity,
    max_article_similarity: candidate.max_article_similarity,
    strongest_article_match: candidate.strongest_article_match,
    left_cluster: clusterInput(candidate.left),
    right_cluster: clusterInput(candidate.right),
  };
}

function inputHash(candidate) {
  return hashInput(JSON.stringify({
    version: 'cross-category-adjudication-v1',
    model: config.crossCategoryAdjudicationModel,
    thresholds: {
      min_centroid_similarity: config.crossCategoryAdjudicationMinCentroidSimilarity,
      article_scan_min_centroid_similarity: config.crossCategoryAdjudicationArticleScanMinCentroidSimilarity,
      min_article_similarity: config.crossCategoryAdjudicationMinArticleSimilarity,
      merge_confidence: config.crossCategoryAdjudicationMergeConfidence,
      apply_merges: config.crossCategoryAdjudicationApplyMerges,
    },
    candidate: candidateInput(candidate),
  }));
}

function maxArticleSimilarity(left, right) {
  let best = {
    similarity: -1,
    left_article: null,
    right_article: null,
  };

  for (const leftArticle of left.articles) {
    if (!leftArticle.embedding) continue;
    for (const rightArticle of right.articles) {
      if (!rightArticle.embedding) continue;
      const similarity = dotProduct(leftArticle.embedding, rightArticle.embedding);
      if (similarity > best.similarity) {
        best = {
          similarity,
          left_article: cleanText(leftArticle.title).slice(0, 260),
          right_article: cleanText(rightArticle.title).slice(0, 260),
        };
      }
    }
  }

  return {
    ...best,
    similarity: Number(Math.max(0, best.similarity).toFixed(6)),
  };
}

async function loadClusters() {
  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.category_id,
      sc.centroid_embedding,
      sc.article_count,
      sc.latest_published_at,
      tc.slug AS category_slug,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      (
        sc.created_at >= NOW() - ($5::int * INTERVAL '1 hour')
        OR sc.updated_at >= NOW() - ($5::int * INTERVAL '1 hour')
        OR cis.scored_at >= NOW() - ($5::int * INTERVAL '1 hour')
      ) AS is_seed,
      a.id AS article_id,
      a.title AS article_title,
      a.summary AS article_summary,
      a.canonical_url,
      a.published_at,
      ae.embedding AS article_embedding
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    JOIN article_embeddings ae
      ON ae.article_id = a.id
      AND ae.embedding_model = $1
    WHERE tc.slug = ANY($2::text[])
      AND cis.impact_level = ANY($3::text[])
      AND sc.latest_published_at >= NOW() - ($4::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
    ORDER BY tc.slug, cis.impact_level, cis.impact_score DESC, sc.latest_published_at DESC, ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
  `, [
    config.embeddingModel,
    config.crossCategoryAdjudicationCategories,
    config.crossCategoryAdjudicationLevels,
    config.crossCategoryAdjudicationWindowHours,
    config.crossCategoryAdjudicationSeedWindowHours,
  ]);

  const clusters = new Map();
  for (const row of rows) {
    if (!clusters.has(row.id)) {
      clusters.set(row.id, {
        id: row.id,
        title: row.title,
        category_id: row.category_id,
        category_slug: row.category_slug,
        centroid_embedding: parseEmbedding(row.centroid_embedding),
        vector_neighbor_ids: [],
        article_count: Number(row.article_count || 0),
        latest_published_at: row.latest_published_at,
        impact_level: row.impact_level,
        impact_score: Number(row.impact_score || 0),
        impact_category: row.impact_category,
        is_seed: row.is_seed,
        articles: [],
      });
    }

    clusters.get(row.id).articles.push({
      id: row.article_id,
      title: row.article_title,
      summary: row.article_summary,
      url: row.canonical_url,
      source: hostFromUrl(row.canonical_url),
      published_at: row.published_at,
      embedding: normalize(parseEmbedding(row.article_embedding)),
    });
  }

  const result = [...clusters.values()];
  const seedIds = result.filter((cluster) => cluster.is_seed).map((cluster) => cluster.id);
  const vectorNeighborMap = await loadVectorNeighborMap(seedIds);
  for (const cluster of result) {
    cluster.vector_neighbor_ids = vectorNeighborMap.get(cluster.id) || [];
  }

  return result;
}

async function loadVectorNeighborMap(seedIds) {
  if (seedIds.length === 0) return new Map();

  const { rows } = await pool.query(`
    SELECT
      seed.id AS seed_id,
      coalesce(array_agg(neighbor.id ORDER BY neighbor.distance ASC) FILTER (WHERE neighbor.id IS NOT NULL), '{}'::uuid[]) AS vector_neighbor_ids
    FROM story_clusters seed
    LEFT JOIN LATERAL (
      SELECT
        other.id,
        other.centroid_embedding_vector <=> seed.centroid_embedding_vector AS distance
      FROM story_clusters other
      JOIN topic_categories other_tc ON other_tc.id = other.category_id
      JOIN cluster_impact_scores other_cis ON other_cis.cluster_id = other.id
      WHERE other.id <> seed.id
        AND other.category_id <> seed.category_id
        AND other.embedding_model = $2
        AND other.centroid_embedding_vector IS NOT NULL
        AND other_tc.slug = ANY($3::text[])
        AND other_cis.impact_level = ANY($4::text[])
        AND other.latest_published_at >= NOW() - ($5::int * INTERVAL '1 hour')
        AND other.latest_published_at <= NOW()
      ORDER BY other.centroid_embedding_vector <=> seed.centroid_embedding_vector
      LIMIT $6
    ) neighbor ON TRUE
    WHERE seed.id = ANY($1::uuid[])
      AND seed.embedding_model = $2
      AND seed.centroid_embedding_vector IS NOT NULL
    GROUP BY seed.id
  `, [
    seedIds,
    config.embeddingModel,
    config.crossCategoryAdjudicationCategories,
    config.crossCategoryAdjudicationLevels,
    config.crossCategoryAdjudicationWindowHours,
    Math.max(1, Number(config.crossCategoryAdjudicationVectorNeighbors) || 30),
  ]);

  return new Map(rows.map((row) => [row.seed_id, row.vector_neighbor_ids || []]));
}

async function loadExistingHashes(hashes) {
  if (hashes.length === 0) return new Set();
  const { rows } = await pool.query(
    'SELECT input_hash FROM cross_category_cluster_adjudications WHERE input_hash = ANY($1::text[])',
    [hashes],
  );
  return new Set(rows.map((row) => row.input_hash));
}

function maybeCandidate(left, right) {
  if (left.category_id === right.category_id) return null;
  const overlap = tokenOverlap(left, right);
  if (overlap < config.crossCategoryAdjudicationMinTokenOverlap) return null;

  const centroidSimilarity = Number(dotProduct(left.centroid_embedding, right.centroid_embedding).toFixed(6));
  let articleMatch = {
    similarity: 0,
    left_article: null,
    right_article: null,
  };

  if (centroidSimilarity >= config.crossCategoryAdjudicationArticleScanMinCentroidSimilarity) {
    articleMatch = maxArticleSimilarity(left, right);
  }

  const strongCentroid = centroidSimilarity >= config.crossCategoryAdjudicationMinCentroidSimilarity;
  const strongArticleMatch = articleMatch.similarity >= config.crossCategoryAdjudicationMinArticleSimilarity;
  if (!strongCentroid && !strongArticleMatch) return null;

  const candidate = {
    id: pairKey(left, right),
    pair_type: pairType(left, right),
    left,
    right,
    centroid_similarity: centroidSimilarity,
    max_article_similarity: articleMatch.similarity,
    token_overlap: overlap,
    strongest_article_match: {
      left_title: articleMatch.left_article,
      right_title: articleMatch.right_article,
    },
  };
  candidate.input_hash = inputHash(candidate);
  return candidate;
}

async function loadCandidates() {
  const clusters = (await loadClusters()).map((cluster) => ({
    ...cluster,
    tokens: clusterTokens(cluster),
  }));
  const candidates = [];
  let tokenCandidatePairs = 0;
  let tokenMatchedPairs = 0;

  const {
    pairs,
    seedClusters,
    indexedTokens,
    skippedTokens,
    indexedPostings,
  } = candidatePairsFromTokenIndex(clusters);

  for (const [left, right] of pairs) {
    tokenCandidatePairs += 1;
    const candidate = maybeCandidate(left, right);
    if (candidate) {
      tokenMatchedPairs += 1;
      candidates.push(candidate);
    }
  }

  const existing = await loadExistingHashes(candidates.map((candidate) => candidate.input_hash));
  const filtered = candidates
    .filter((candidate) => !existing.has(candidate.input_hash))
    .sort((left, right) => {
      const leftScore = Math.max(left.centroid_similarity, left.max_article_similarity);
      const rightScore = Math.max(right.centroid_similarity, right.max_article_similarity);
      return rightScore - leftScore;
    })
    .slice(0, config.crossCategoryAdjudicationBatchSize);
  console.log(
    `Cross-category candidate scan: clusters=${clusters.length} seed_clusters=${seedClusters} ` +
      `indexed_tokens=${indexedTokens} skipped_tokens=${skippedTokens} indexed_postings=${indexedPostings} ` +
      `token_pairs=${tokenCandidatePairs} embedding_candidates=${tokenMatchedPairs} new_candidates=${filtered.length}`,
  );
  return filtered;
}

async function adjudicateCandidates(openai, candidates) {
  if (candidates.length === 0) return [];

  const response = await openai.responses.create({
    model: config.crossCategoryAdjudicationModel,
    input: [
      {
        role: 'system',
        content: [
          'You decide whether two technology news clusters from different categories describe the same real-world news event.',
          `The category slugs under review are: ${config.crossCategoryAdjudicationCategories.join(', ')}.`,
          'same_story means same event, announcement, deal, policy move, model release, incident, vulnerability, outage, study, or lawsuit.',
          'related_but_distinct means same actors/theme but materially different event or angle.',
          'distinct means they are not the same story.',
          'insufficient_evidence means evidence is too weak to merge safely.',
          'Be conservative: cross-category overlap is common, but related topic is not enough.',
          'Return exactly one result for every candidate_id provided. Do not omit candidates.',
          'Return only structured JSON matching the schema.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          version: 'cross-category-adjudication-v1',
          merge_policy: {
            apply_merges: config.crossCategoryAdjudicationApplyMerges,
            same_story: 'mark as duplicate across categories; merge only when apply_merges is true and confidence passes threshold',
            do_not_merge: 'related_but_distinct, distinct, or insufficient_evidence',
          },
          candidates: candidates.map(candidateInput),
        }),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'cross_category_cluster_adjudications',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['results'],
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['candidate_id', 'decision', 'confidence', 'rationale', 'matched_evidence'],
                properties: {
                  candidate_id: { type: 'string' },
                  decision: {
                    type: 'string',
                    enum: ['same_story', 'related_but_distinct', 'distinct', 'insufficient_evidence'],
                  },
                  confidence: { type: 'number' },
                  rationale: { type: 'string' },
                  matched_evidence: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const parsed = JSON.parse(responseText(response));
  const expectedIds = new Set(candidates.map((candidate) => candidate.id));
  const uniqueResults = new Map();
  for (const result of parsed.results || []) {
    if (expectedIds.has(result.candidate_id) && !uniqueResults.has(result.candidate_id)) {
      uniqueResults.set(result.candidate_id, result);
    }
  }
  return [...uniqueResults.values()];
}

async function clusterExists(clusterId) {
  const { rowCount } = await pool.query('SELECT 1 FROM story_clusters WHERE id = $1', [clusterId]);
  return rowCount > 0;
}

async function saveAdjudication(candidate, result, merged, target, source) {
  const evidence = Array.isArray(result.matched_evidence)
    ? result.matched_evidence.map(cleanText).filter(Boolean).slice(0, 8)
    : [];

  await pool.query(
    `INSERT INTO cross_category_cluster_adjudications (
       input_hash, pair_type, left_category_slug, right_category_slug,
       left_cluster_id, right_cluster_id, target_cluster_id, source_cluster_id,
       left_impact_level, right_impact_level,
       left_title, right_title,
       centroid_similarity, max_article_similarity,
       decision, confidence, rationale, matched_evidence, merged, model
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20)
     ON CONFLICT (input_hash) DO UPDATE SET
       decision = EXCLUDED.decision,
       confidence = EXCLUDED.confidence,
       rationale = EXCLUDED.rationale,
       matched_evidence = EXCLUDED.matched_evidence,
       merged = EXCLUDED.merged`,
    [
      candidate.input_hash,
      candidate.pair_type,
      candidate.left.category_slug,
      candidate.right.category_slug,
      candidate.left.id,
      candidate.right.id,
      target.id,
      source.id,
      candidate.left.impact_level,
      candidate.right.impact_level,
      cleanText(candidate.left.title).slice(0, 500),
      cleanText(candidate.right.title).slice(0, 500),
      candidate.centroid_similarity,
      candidate.max_article_similarity,
      normalizeDecision(result.decision),
      normalizeConfidence(result.confidence),
      cleanText(result.rationale).slice(0, 1000),
      JSON.stringify(evidence),
      merged,
      config.crossCategoryAdjudicationModel,
    ],
  );
}

async function loadPendingSameStoryAdjudications() {
  const { rows } = await pool.query(`
    SELECT
      cca.id,
      cca.centroid_similarity,
      cca.confidence,
      left_sc.id AS left_id,
      left_sc.title AS left_title,
      left_sc.article_count AS left_article_count,
      left_sc.latest_published_at AS left_latest_published_at,
      left_tc.slug AS left_category_slug,
      left_cis.impact_level AS left_impact_level,
      right_sc.id AS right_id,
      right_sc.title AS right_title,
      right_sc.article_count AS right_article_count,
      right_sc.latest_published_at AS right_latest_published_at,
      right_tc.slug AS right_category_slug,
      right_cis.impact_level AS right_impact_level
    FROM cross_category_cluster_adjudications cca
    JOIN story_clusters left_sc ON left_sc.id = cca.left_cluster_id
    JOIN topic_categories left_tc ON left_tc.id = left_sc.category_id
    JOIN cluster_impact_scores left_cis ON left_cis.cluster_id = left_sc.id
    JOIN story_clusters right_sc ON right_sc.id = cca.right_cluster_id
    JOIN topic_categories right_tc ON right_tc.id = right_sc.category_id
    JOIN cluster_impact_scores right_cis ON right_cis.cluster_id = right_sc.id
    WHERE cca.decision = 'same_story'
      AND cca.merged = false
      AND cca.confidence >= $1
    ORDER BY cca.confidence DESC, cca.created_at ASC
  `, [config.crossCategoryAdjudicationMergeConfidence]);

  return rows.map((row) => ({
    id: row.id,
    confidence: normalizeConfidence(row.confidence),
    similarity: Number(row.centroid_similarity || 0),
    left: {
      id: row.left_id,
      title: row.left_title,
      article_count: Number(row.left_article_count || 0),
      latest_published_at: row.left_latest_published_at,
      category_slug: row.left_category_slug,
      impact_level: row.left_impact_level,
    },
    right: {
      id: row.right_id,
      title: row.right_title,
      article_count: Number(row.right_article_count || 0),
      latest_published_at: row.right_latest_published_at,
      category_slug: row.right_category_slug,
      impact_level: row.right_impact_level,
    },
  }));
}

async function applyPendingSameStoryMerges() {
  if (!config.crossCategoryAdjudicationApplyMerges) return { merged: 0, considered: 0 };

  const adjudications = await loadPendingSameStoryAdjudications();
  let merged = 0;

  for (const adjudication of adjudications) {
    const [target, source] = chooseCrossCategoryTarget(adjudication.left, adjudication.right);
    const targetExists = await clusterExists(target.id);
    const sourceExists = await clusterExists(source.id);
    if (!targetExists || !sourceExists) continue;

    const mergeResult = await mergePair({
      target,
      source,
      similarity: adjudication.similarity,
    });

    if (mergeResult.merged) {
      merged += 1;
      await pool.query(
        `UPDATE cross_category_cluster_adjudications
         SET target_cluster_id = $2,
             source_cluster_id = $3,
             merged = true
         WHERE id = $1`,
        [adjudication.id, target.id, source.id],
      );
      console.log(`Cross-category existing merge ${source.category_slug}:${source.id} -> ${target.category_slug}:${target.id} confidence=${adjudication.confidence}`);
    }
  }

  return { merged, considered: adjudications.length };
}

async function applyAdjudications(candidates, results) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let saved = 0;
  let merged = 0;

  for (const result of results) {
    const candidate = candidatesById.get(result.candidate_id);
    if (!candidate) continue;

    const [target, source] = chooseCrossCategoryTarget(candidate.left, candidate.right);
    const decision = normalizeDecision(result.decision);
    const confidence = normalizeConfidence(result.confidence);
    const shouldMerge = (
      config.crossCategoryAdjudicationApplyMerges
      && decision === 'same_story'
      && confidence >= config.crossCategoryAdjudicationMergeConfidence
    );
    let didMerge = false;

    if (shouldMerge) {
      const targetExists = await clusterExists(target.id);
      const sourceExists = await clusterExists(source.id);
      if (targetExists && sourceExists) {
        const mergeResult = await mergePair({
          target,
          source,
          similarity: candidate.centroid_similarity,
        });
        didMerge = mergeResult.merged;
        if (didMerge) merged += 1;
      }
    }

    await saveAdjudication(candidate, result, didMerge, target, source);
    saved += 1;
    console.log(`Cross-category ${decision} ${candidate.left.category_slug}:${candidate.left.id} <> ${candidate.right.category_slug}:${candidate.right.id} confidence=${confidence} merged=${didMerge}`);
  }

  return { saved, merged };
}

export async function runCrossCategoryAdjudication({
  closeConnections = true,
  runUntilEmpty = config.crossCategoryAdjudicationRunUntilEmpty,
} = {}) {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required to adjudicate cross-category cluster duplicates');
  }

  const tracing = startLangfuseTracing();
  const openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
    model: config.crossCategoryAdjudicationModel,
    categories: config.crossCategoryAdjudicationCategories,
    levels: config.crossCategoryAdjudicationLevels,
    windowHours: config.crossCategoryAdjudicationWindowHours,
    seedWindowHours: config.crossCategoryAdjudicationSeedWindowHours,
    minCentroidSimilarity: config.crossCategoryAdjudicationMinCentroidSimilarity,
    minArticleSimilarity: config.crossCategoryAdjudicationMinArticleSimilarity,
    applyMerges: config.crossCategoryAdjudicationApplyMerges,
  }, {
    traceName: 'signalrss-cross-category-cluster-adjudicator',
    component: 'cross-category-cluster-adjudicator',
  });

  try {
    const pendingMerges = await applyPendingSameStoryMerges();
    if (pendingMerges.considered > 0) {
      console.log(`Cross-category existing same_story merges: merged ${pendingMerges.merged}/${pendingMerges.considered}`);
    }

    let totalSaved = 0;
    let totalMerged = 0;
    let batch = 0;

    do {
      batch += 1;
      const candidates = await loadCandidates();
      if (candidates.length === 0) {
        console.log(`Cross-category adjudication batch ${batch}: 0 candidates`);
        break;
      }

      const results = await adjudicateCandidates(openai, candidates);
      const applied = await applyAdjudications(candidates, results);
      totalSaved += applied.saved;
      totalMerged += applied.merged;
      console.log(`Cross-category adjudication batch ${batch}: saved ${applied.saved}/${candidates.length}, merged ${applied.merged}`);
    } while (runUntilEmpty);

    console.log(`Cross-category adjudication total: saved ${totalSaved}, merged ${totalMerged}`);
    console.log(`Langfuse tracing ${tracing.enabled ? 'enabled' : 'disabled'}`);
  } finally {
    await shutdownLangfuseTracing().catch(() => {});
    if (closeConnections) await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCrossCategoryAdjudication().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
