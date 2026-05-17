import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { chooseTarget, mergePair } from './merge-clusters.js';
import { observeOpenAIClient, shutdownLangfuseTracing, startLangfuseTracing } from './langfuse.js';
import { pairTypeFor, priorityAdjudicationSettings } from './priority-config.js';
import { cleanText, hashInput } from './text-utils.js';

const DECISIONS = new Set(['same_story', 'related_but_distinct', 'distinct', 'insufficient_evidence']);

function categoryLabel(slug = '') {
  return cleanText(slug || 'technology').replaceAll('-', ' ');
}

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

function responseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('');
}

function pairKey(pairType, left, right) {
  return `${pairType}:${[left.id, right.id].sort().join(':')}`;
}

function clusterInput(cluster) {
  return {
    cluster_id: cluster.id,
    impact_level: cluster.impact_level,
    impact_score: Number(cluster.impact_score || 0),
    impact_category: cluster.impact_category,
    title: cleanText(cluster.title).slice(0, 260),
    article_count: Number(cluster.article_count || 0),
    latest_published_at: cluster.latest_published_at,
    articles: cluster.articles.slice(0, 10).map((article) => ({
      title: cleanText(article.title).slice(0, 260),
      source: article.source,
      published_at: article.published_at,
      summary: cleanText(article.summary).slice(0, 700),
    })),
  };
}

function candidateInput(candidate) {
  return {
    candidate_id: candidate.id,
    pair_type: candidate.pair_type,
    category_slug: candidate.left.category_slug,
    centroid_similarity: candidate.centroid_similarity,
    max_article_similarity: candidate.max_article_similarity,
    shared_strong_tokens: candidate.shared_strong_tokens,
    strongest_article_match: candidate.strongest_article_match,
    left_cluster: clusterInput(candidate.left),
    right_cluster: clusterInput(candidate.right),
  };
}

function legacyP0ClusterInput(cluster) {
  return {
    cluster_id: cluster.id,
    title: cleanText(cluster.title).slice(0, 240),
    impact_score: Number(cluster.impact_score || 0),
    impact_category: cluster.impact_category,
    article_count: Number(cluster.article_count || 0),
    latest_published_at: cluster.latest_published_at,
    articles: cluster.articles.slice(0, 10).map((article) => ({
      title: cleanText(article.title).slice(0, 240),
      source: article.source,
      published_at: article.published_at,
      summary: cleanText(article.summary).slice(0, 700),
    })),
  };
}

function legacyP0CandidateInput(candidate) {
  return {
    candidate_id: [candidate.left.id, candidate.right.id].sort().join(':'),
    category_slug: candidate.left.category_slug,
    centroid_similarity: candidate.centroid_similarity,
    max_article_similarity: candidate.max_article_similarity,
    shared_strong_tokens: candidate.shared_strong_tokens,
    strongest_article_match: {
      left_title: cleanText(candidate.strongest_article_match.left_title).slice(0, 240),
      right_title: cleanText(candidate.strongest_article_match.right_title).slice(0, 240),
    },
    left_cluster: legacyP0ClusterInput(candidate.left),
    right_cluster: legacyP0ClusterInput(candidate.right),
  };
}

function legacyThresholdHash(settings) {
  if (settings.level === 'P0') {
    return {
      min_centroid_similarity: settings.thresholds.p0_p0,
      max_centroid_similarity: settings.maxCentroidSimilarity,
      min_article_similarity: settings.minArticleSimilarity,
      merge_confidence: settings.mergeConfidence,
    };
  }

  const compact = settings.level.toLowerCase();
  const thresholds = {};
  thresholds[`${compact}${compact}_min_centroid_similarity`] = settings.thresholds[pairTypeFor(settings.level, settings.level)];
  for (const targetLevel of [...settings.compareToLevels].reverse()) {
    thresholds[`${compact}${targetLevel.toLowerCase()}_min_centroid_similarity`] = settings.thresholds[pairTypeFor(settings.level, targetLevel)];
  }
  thresholds.max_centroid_similarity = settings.maxCentroidSimilarity;
  thresholds.min_article_similarity = settings.minArticleSimilarity;
  thresholds.merge_confidence = settings.mergeConfidence;
  return thresholds;
}

function inputHash(settings, candidate) {
  return hashInput(JSON.stringify({
    version: settings.version,
    model: settings.model,
    thresholds: legacyThresholdHash(settings),
    candidate: settings.level === 'P0' ? legacyP0CandidateInput(candidate) : candidateInput(candidate),
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

const GENERIC_ACRONYM_STOP_TOKENS = new Set([
  'AI',
  'API',
  'APP',
  'CEO',
  'CFO',
  'CTO',
  'EU',
  'IT',
  'LLM',
  'ML',
  'UK',
  'US',
  'USA',
]);

const UNIT_ALIASES = new Map([
  ['bn', 'b'],
  ['billion', 'b'],
  ['million', 'm'],
  ['gigawatt', 'gw'],
  ['gigawatts', 'gw'],
  ['吉瓦', 'gw'],
  ['亿美元', 'usd-100m'],
]);

function normalizeNumberToken(value = '') {
  const normalized = String(value).replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return '';
  return Number.isInteger(parsed) ? String(parsed) : String(parsed).replace(/0+$/, '').replace(/\.$/, '');
}

function addStrongToken(tokens, token) {
  const cleaned = cleanText(token).toLowerCase();
  if (!cleaned) return;
  tokens.add(cleaned);
}

function collectStrongTokensFromText(value, tokens) {
  const text = cleanText(value);
  if (!text) return;

  const acronymMatches = text.matchAll(/\b[A-Z][A-Z0-9&.-]{1,14}\b/g);
  for (const match of acronymMatches) {
    const token = match[0].replace(/[.]+$/g, '');
    if (!GENERIC_ACRONYM_STOP_TOKENS.has(token)) {
      addStrongToken(tokens, `entity:${token}`);
    }
  }

  const latinUnitMatches = text.matchAll(/\b(\d+(?:[.,]\d+)?)\s?(gw|gigawatt|gigawatts|m|bn|billion|million|b)\b/gi);
  for (const match of latinUnitMatches) {
    const number = normalizeNumberToken(match[1]);
    const unit = UNIT_ALIASES.get(match[2].toLowerCase()) || match[2].toLowerCase();
    if (number && unit) addStrongToken(tokens, `amount:${number}:${unit}`);
  }

  const chineseUnitMatches = text.matchAll(/(\d+(?:[.,]\d+)?)\s?(吉瓦|亿美元)/g);
  for (const match of chineseUnitMatches) {
    const number = normalizeNumberToken(match[1]);
    const unit = UNIT_ALIASES.get(match[2]) || match[2];
    if (number && unit) addStrongToken(tokens, `amount:${number}:${unit}`);
  }
}

function strongTokens(cluster) {
  const tokens = new Set();
  collectStrongTokensFromText(cluster.title, tokens);
  for (const article of cluster.articles) {
    collectStrongTokensFromText(article.title, tokens);
    collectStrongTokensFromText(article.summary, tokens);
  }
  return tokens;
}

function sharedStrongTokens(left, right) {
  const leftTokens = strongTokens(left);
  const rightTokens = strongTokens(right);
  return [...leftTokens]
    .filter((token) => rightTokens.has(token))
    .sort()
    .slice(0, 12);
}

async function loadClusters(settings) {
  const params = [
    config.embeddingModel,
    settings.windowHours,
    settings.loadedLevels,
  ];
  let categoryFilter = '';

  if (settings.categorySlug) {
    params.push(settings.categorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

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
    WHERE cis.impact_level = ANY($3::text[])
      AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
      ${categoryFilter}
    ORDER BY cis.impact_level, cis.impact_score DESC, sc.latest_published_at DESC, ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
  `, params);

  const clusters = new Map();
  for (const row of rows) {
    if (!clusters.has(row.id)) {
      clusters.set(row.id, {
        id: row.id,
        title: row.title,
        category_id: row.category_id,
        category_slug: row.category_slug,
        centroid_embedding: parseEmbedding(row.centroid_embedding),
        article_count: Number(row.article_count || 0),
        latest_published_at: row.latest_published_at,
        impact_level: row.impact_level,
        impact_score: Number(row.impact_score || 0),
        impact_category: row.impact_category,
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

  return [...clusters.values()];
}

async function loadVectorPairRows(settings) {
  const params = [
    config.embeddingModel,
    settings.windowHours,
    settings.loadedLevels,
    settings.level,
    config.priorityAdjudicationVectorNeighbors,
    settings.compareToLevels,
  ];
  let categoryFilter = '';

  if (settings.categorySlug) {
    params.push(settings.categorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    WITH source_clusters AS (
      SELECT
        sc.id,
        sc.category_id,
        tc.slug AS category_slug,
        cis.impact_level,
        sc.centroid_embedding_vector
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE sc.embedding_model = $1
        AND sc.centroid_embedding_vector IS NOT NULL
        AND cis.impact_level = ANY($3::text[])
        AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 hour')
        AND sc.latest_published_at <= NOW()
        ${categoryFilter}
        AND cis.impact_level = $4
    )
    SELECT DISTINCT ON (LEAST(source.id, candidate.id), GREATEST(source.id, candidate.id), lower(source.impact_level) || '_' || lower(candidate.impact_level))
      source.id AS left_id,
      candidate.id AS right_id,
      lower(source.impact_level) || '_' || lower(candidate.impact_level) AS pair_type,
      1 - (source.centroid_embedding_vector <=> candidate.centroid_embedding_vector) AS centroid_similarity
    FROM source_clusters source
    JOIN LATERAL (
      SELECT
        candidate_sc.id,
        candidate_sc.category_id,
        candidate_cis.impact_level,
        candidate_sc.centroid_embedding_vector
      FROM story_clusters candidate_sc
      JOIN cluster_impact_scores candidate_cis ON candidate_cis.cluster_id = candidate_sc.id
      WHERE candidate_sc.id <> source.id
        AND candidate_sc.category_id = source.category_id
        AND candidate_sc.embedding_model = $1
        AND candidate_sc.centroid_embedding_vector IS NOT NULL
        AND candidate_sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 hour')
        AND candidate_sc.latest_published_at <= NOW()
        AND (
          candidate_cis.impact_level = source.impact_level
          OR candidate_cis.impact_level = ANY($6::text[])
        )
      ORDER BY candidate_sc.centroid_embedding_vector <=> source.centroid_embedding_vector
      LIMIT $5
    ) candidate ON TRUE
    ORDER BY
      LEAST(source.id, candidate.id),
      GREATEST(source.id, candidate.id),
      lower(source.impact_level) || '_' || lower(candidate.impact_level),
      centroid_similarity DESC
  `, params);

  return rows;
}

async function loadExistingHashes(settings, hashes) {
  if (hashes.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT input_hash FROM ${settings.tableName} WHERE input_hash = ANY($1::text[])`,
    [hashes],
  );
  return new Set(rows.map((row) => row.input_hash));
}

function buildCandidate(settings, pairType, left, right, centroidSimilarity, articleMatch, sharedTokens = []) {
  const candidate = {
    id: pairKey(pairType, left, right),
    pair_type: pairType,
    left,
    right,
    centroid_similarity: centroidSimilarity,
    max_article_similarity: articleMatch.similarity,
    shared_strong_tokens: sharedTokens,
    strongest_article_match: {
      left_title: articleMatch.left_article,
      right_title: articleMatch.right_article,
    },
  };
  candidate.input_hash = inputHash(settings, candidate);
  return candidate;
}

function maybeCandidate(settings, pairType, left, right) {
  if (left.category_id !== right.category_id) return null;
  const minCentroidSimilarity = settings.thresholds[pairType];
  if (minCentroidSimilarity === undefined) return null;

  const centroidSimilarity = Number(dotProduct(left.centroid_embedding, right.centroid_embedding).toFixed(6));
  const articleMatch = maxArticleSimilarity(left, right);
  const inCentroidBand = (
    centroidSimilarity >= minCentroidSimilarity
    && centroidSimilarity < settings.maxCentroidSimilarity
  );
  const strongArticleMatch = articleMatch.similarity >= settings.minArticleSimilarity;
  const sharedTokens = sharedStrongTokens(left, right);
  const relaxedCandidate = centroidSimilarity < settings.relaxedCandidateBaselineSimilarity;
  const hasStrongTokenEvidence = sharedTokens.length >= settings.minStrongTokenOverlap;
  if (inCentroidBand && relaxedCandidate && !hasStrongTokenEvidence && !strongArticleMatch) return null;
  if (!inCentroidBand && !strongArticleMatch) return null;
  return buildCandidate(settings, pairType, left, right, centroidSimilarity, articleMatch, sharedTokens);
}

function candidatePriority(settings) {
  const priorities = new Map();
  settings.compareToLevels.forEach((targetLevel, index) => {
    priorities.set(pairTypeFor(settings.level, targetLevel), index);
  });
  priorities.set(pairTypeFor(settings.level, settings.level), settings.compareToLevels.length);
  return priorities;
}

async function loadCandidates(settings) {
  const clusters = await loadClusters(settings);
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const vectorPairs = await loadVectorPairRows(settings);
  const candidates = [];

  for (const pair of vectorPairs) {
    const left = clustersById.get(pair.left_id);
    const right = clustersById.get(pair.right_id);
    if (!left || !right) continue;
    const candidate = maybeCandidate(settings, pair.pair_type, left, right);
    if (candidate) candidates.push(candidate);
  }

  const existing = await loadExistingHashes(settings, candidates.map((candidate) => candidate.input_hash));
  const priorities = candidatePriority(settings);
  return candidates
    .filter((candidate) => !existing.has(candidate.input_hash))
    .sort((left, right) => {
      const leftPriority = priorities.get(left.pair_type) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priorities.get(right.pair_type) ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return Math.max(right.centroid_similarity, right.max_article_similarity)
        - Math.max(left.centroid_similarity, left.max_article_similarity);
    })
    .slice(0, settings.batchSize);
}

function mergePolicy(settings) {
  const policy = {
    do_not_merge: 'related_but_distinct, distinct, or insufficient_evidence',
  };
  for (const targetLevel of settings.compareToLevels) {
    const pairType = pairTypeFor(settings.level, targetLevel);
    policy[pairType] = `merge ${settings.level} into ${targetLevel} only if same_story with confidence >= configured threshold`;
  }
  policy[pairTypeFor(settings.level, settings.level)] = `merge ${settings.level} clusters only if same_story with confidence >= configured threshold`;
  return policy;
}

function pairTypeDescription(settings) {
  const pairTypes = [...settings.compareToLevels, settings.level]
    .map((targetLevel) => pairTypeFor(settings.level, targetLevel));
  return pairTypes.length === 1
    ? `The pair_type is ${pairTypes[0]}.`
    : `The pair_type is ${pairTypes.slice(0, -1).join(', ')}, or ${pairTypes[pairTypes.length - 1]}.`;
}

function pairInstructions(settings) {
  const instructions = settings.compareToLevels.map((targetLevel) => (
    `For ${pairTypeFor(settings.level, targetLevel)}, merge ${settings.level} into ${targetLevel} only if they are the same story.`
  ));
  instructions.push(`For ${pairTypeFor(settings.level, settings.level)}, merge the two ${settings.level} clusters only if they are the same story.`);
  return instructions;
}

async function adjudicateCandidates(openai, settings, candidates) {
  if (candidates.length === 0) return [];

  const category = categoryLabel(settings.categorySlug || candidates[0]?.left?.category_slug);
  const response = await openai.responses.create({
    model: settings.model,
    input: [
      {
        role: 'system',
        content: [
          `You decide whether two ${category} news clusters describe the same real-world news event.`,
          pairTypeDescription(settings),
          ...pairInstructions(settings),
          'Use only titles, summaries, timestamps, sources, and similarity metrics.',
          'For low-centroid candidates, use shared_strong_tokens only as candidate-retrieval evidence; still require the same concrete event to merge.',
          'same_story means same event, announcement, deal, policy move, model release, incident, study, or lawsuit.',
          'related_but_distinct means same actors/theme but materially different event or angle.',
          'distinct means they are not the same story.',
          'insufficient_evidence means evidence is too weak to merge safely.',
          settings.conservativePrompt,
          'Return exactly one result for every candidate_id provided. Do not omit candidates.',
          'Return only structured JSON matching the schema.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          version: settings.version,
          merge_policy: mergePolicy(settings),
          candidates: candidates.map(candidateInput),
        }),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: settings.schemaName,
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

function normalizeDecision(value) {
  return DECISIONS.has(value) ? value : 'insufficient_evidence';
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, confidence));
}

async function clusterExists(clusterId) {
  const { rowCount } = await pool.query('SELECT 1 FROM story_clusters WHERE id = $1', [clusterId]);
  return rowCount > 0;
}

function choosePriorityTarget(settings, candidate) {
  for (const targetLevel of settings.compareToLevels) {
    if (candidate.pair_type === pairTypeFor(settings.level, targetLevel)) {
      return candidate.left.impact_level === targetLevel
        ? [candidate.left, candidate.right]
        : [candidate.right, candidate.left];
    }
  }
  return chooseTarget(candidate.left, candidate.right);
}

async function saveP0Adjudication(settings, candidate, result, merged, target, source) {
  await pool.query(
    `INSERT INTO p0_cluster_merge_adjudications (
       input_hash, category_slug,
       left_cluster_id, right_cluster_id, target_cluster_id, source_cluster_id,
       left_title, right_title,
       centroid_similarity, max_article_similarity,
       decision, confidence, rationale, matched_evidence, merged, model
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
     ON CONFLICT (input_hash) DO UPDATE SET
       decision = EXCLUDED.decision,
       confidence = EXCLUDED.confidence,
       rationale = EXCLUDED.rationale,
       matched_evidence = EXCLUDED.matched_evidence,
       merged = EXCLUDED.merged`,
    [
      candidate.input_hash,
      candidate.left.category_slug,
      candidate.left.id,
      candidate.right.id,
      target.id,
      source.id,
      cleanText(candidate.left.title).slice(0, 500),
      cleanText(candidate.right.title).slice(0, 500),
      candidate.centroid_similarity,
      candidate.max_article_similarity,
      normalizeDecision(result.decision),
      normalizeConfidence(result.confidence),
      cleanText(result.rationale).slice(0, 1000),
      JSON.stringify(Array.isArray(result.matched_evidence)
        ? result.matched_evidence.map(cleanText).filter(Boolean).slice(0, 8)
        : []),
      merged,
      settings.model,
    ],
  );
}

async function savePriorityAdjudication(settings, candidate, result, merged, target, source) {
  if (settings.level === 'P0') {
    await saveP0Adjudication(settings, candidate, result, merged, target, source);
    return;
  }

  const decision = normalizeDecision(result.decision);
  const confidence = normalizeConfidence(result.confidence);
  const evidence = Array.isArray(result.matched_evidence)
    ? result.matched_evidence.map(cleanText).filter(Boolean).slice(0, 8)
    : [];

  await pool.query(
    `INSERT INTO ${settings.tableName} (
       input_hash, pair_type, category_slug,
       left_cluster_id, right_cluster_id, target_cluster_id, source_cluster_id,
       left_impact_level, right_impact_level,
       left_title, right_title,
       centroid_similarity, max_article_similarity,
       decision, confidence, rationale, matched_evidence, merged, model
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
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
      decision,
      confidence,
      cleanText(result.rationale).slice(0, 1000),
      JSON.stringify(evidence),
      merged,
      settings.model,
    ],
  );
}

async function applyAdjudications(settings, candidates, results) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let saved = 0;
  let merged = 0;

  for (const result of results) {
    const candidate = candidatesById.get(result.candidate_id);
    if (!candidate) continue;

    const [target, source] = choosePriorityTarget(settings, candidate);
    const decision = normalizeDecision(result.decision);
    const confidence = normalizeConfidence(result.confidence);
    const shouldMerge = decision === 'same_story' && confidence >= settings.mergeConfidence;
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
        if (didMerge) {
          merged += 1;
          console.log(`${settings.level} LLM merged ${source.id} -> ${target.id} type=${candidate.pair_type} confidence=${confidence}`);
        }
      }
    }

    await savePriorityAdjudication(settings, candidate, result, didMerge, target, source);
    saved += 1;
    if (!didMerge) {
      console.log(`${settings.level} LLM kept ${candidate.left.id} <> ${candidate.right.id} type=${candidate.pair_type} decision=${decision} confidence=${confidence}`);
    }
  }

  return { saved, merged };
}

export async function runPriorityClusterAdjudication(level, { closeConnections = true } = {}) {
  const settings = priorityAdjudicationSettings(level);
  if (!config.openaiApiKey) {
    throw new Error(`OPENAI_API_KEY is required to adjudicate ${settings.level} cluster merges`);
  }

  try {
    const candidates = await loadCandidates(settings);
    if (candidates.length === 0) {
      console.log(`${settings.level} cluster adjudication: 0 candidates`);
      console.log('Langfuse tracing not started');
      return;
    }

    const tracing = startLangfuseTracing();
    const openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
      model: settings.model,
      categorySlug: settings.categorySlug,
      windowHours: settings.windowHours,
      thresholds: settings.thresholds,
      minArticleSimilarity: settings.minArticleSimilarity,
      mergeConfidence: settings.mergeConfidence,
      impactLevel: settings.level,
    }, {
      traceName: settings.traceName,
      component: settings.component,
    });

    const results = await adjudicateCandidates(openai, settings, candidates);
    const applied = await applyAdjudications(settings, candidates, results);
    console.log(`${settings.level} cluster adjudication: saved ${applied.saved}/${candidates.length}, merged ${applied.merged}`);
    console.log(`Langfuse tracing ${tracing.enabled ? 'enabled' : 'disabled'}`);
  } finally {
    await shutdownLangfuseTracing().catch(() => {});
    if (closeConnections) await closeDb();
  }
}

export async function hasPriorityAdjudicationWork(level) {
  const settings = priorityAdjudicationSettings(level);
  const params = [
    settings.windowHours,
    settings.loadedLevels,
    settings.level,
  ];
  let categoryFilter = '';

  if (settings.categorySlug) {
    params.push(settings.categorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE cis.impact_level = $3)::int AS source_count,
      count(*) FILTER (WHERE cis.impact_level = ANY($2::text[]) AND cis.impact_level <> $3)::int AS target_count
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    WHERE cis.impact_level = ANY($2::text[])
      AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
      ${categoryFilter}
  `, params);

  const sourceCount = Number(rows[0]?.source_count || 0);
  const targetCount = Number(rows[0]?.target_count || 0);
  return sourceCount > 1 || (sourceCount > 0 && targetCount > 0);
}
