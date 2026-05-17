import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { observeOpenAIClient, shutdownLangfuseTracing, startLangfuseTracing } from './langfuse.js';
import { cleanText } from './text-utils.js';

const CATEGORY = process.env.P2_DUPLICATE_CATEGORY_SLUG || 'artificial-intelligence';
const HOURS = Number(process.env.P2_DUPLICATE_WINDOW_HOURS || 168);
const MAX_PAIRS = Number(process.env.P2_DUPLICATE_MAX_PAIRS || 120);
const MODEL = process.env.P2_DUPLICATE_MODEL || 'gpt-5-nano';

const thresholds = {
  p2_p0: Number(process.env.P2_DUPLICATE_P2P0_MIN_CENTROID_SIMILARITY || 0.70),
  p2_p1: Number(process.env.P2_DUPLICATE_P2P1_MIN_CENTROID_SIMILARITY || 0.70),
  p2_p2: Number(process.env.P2_DUPLICATE_P2P2_MIN_CENTROID_SIMILARITY || 0.72),
  article: Number(process.env.P2_DUPLICATE_MIN_ARTICLE_SIMILARITY || 0.72),
  max: Number(process.env.P2_DUPLICATE_MAX_CENTROID_SIMILARITY || 0.82),
};

function parseEmbedding(value) {
  return Array.isArray(value) ? value : JSON.parse(value);
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('');
}

async function loadClusters() {
  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.summary,
      sc.article_count,
      sc.latest_published_at,
      sc.centroid_embedding,
      tc.slug AS category_slug,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      cis.summary AS impact_summary,
      json_agg(
        json_build_object(
          'title', a.title,
          'summary', a.summary,
          'published_at', a.published_at,
          'source', a.source_host,
          'embedding', ae.embedding
        )
        ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
      ) AS articles
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    JOIN article_embeddings ae ON ae.article_id = a.id
    WHERE tc.slug = $1
      AND cis.impact_level IN ('P0', 'P1', 'P2')
      AND sc.latest_published_at >= NOW() - ($2::int * INTERVAL '1 hour')
      AND sc.latest_published_at <= NOW()
    GROUP BY sc.id, tc.slug, cis.cluster_id
  `, [CATEGORY, HOURS]);

  return rows.map((row) => ({
    ...row,
    centroid_embedding: parseEmbedding(row.centroid_embedding),
    articles: (row.articles || []).map((article) => ({
      ...article,
      embedding: parseEmbedding(article.embedding),
    })),
  }));
}

function maxArticleSimilarity(left, right) {
  let best = {
    similarity: -1,
    left_title: null,
    right_title: null,
  };

  for (const leftArticle of left.articles || []) {
    for (const rightArticle of right.articles || []) {
      const similarity = dotProduct(leftArticle.embedding, rightArticle.embedding);
      if (similarity > best.similarity) {
        best = {
          similarity: Number(similarity.toFixed(6)),
          left_title: leftArticle.title,
          right_title: rightArticle.title,
        };
      }
    }
  }

  return best;
}

function clusterInput(cluster) {
  return {
    cluster_id: cluster.id,
    impact_level: cluster.impact_level,
    impact_score: Number(cluster.impact_score || 0),
    title: cleanText(cluster.title).slice(0, 260),
    article_count: Number(cluster.article_count || 0),
    latest_published_at: cluster.latest_published_at,
    articles: (cluster.articles || []).slice(0, 8).map((article) => ({
      title: cleanText(article.title).slice(0, 240),
      source: article.source,
      published_at: article.published_at,
      summary: cleanText(article.summary).slice(0, 650),
    })),
  };
}

function buildCandidate(pairType, left, right) {
  const centroidSimilarity = Number(dotProduct(left.centroid_embedding, right.centroid_embedding).toFixed(6));
  const articleMatch = maxArticleSimilarity(left, right);
  const inCentroidBand = (
    centroidSimilarity >= thresholds[pairType]
    && centroidSimilarity < thresholds.max
  );
  const strongArticleMatch = articleMatch.similarity >= thresholds.article;

  if (!inCentroidBand && !strongArticleMatch) return null;

  return {
    candidate_id: `${pairType}:${[left.id, right.id].sort().join(':')}`,
    pair_type: pairType,
    centroid_similarity: centroidSimilarity,
    max_article_similarity: articleMatch.similarity,
    strongest_article_match: articleMatch,
    left_cluster: clusterInput(left),
    right_cluster: clusterInput(right),
  };
}

function buildCandidates(clusters) {
  const p0 = clusters.filter((cluster) => cluster.impact_level === 'P0');
  const p1 = clusters.filter((cluster) => cluster.impact_level === 'P1');
  const p2 = clusters.filter((cluster) => cluster.impact_level === 'P2');
  const candidates = [];

  for (let leftIndex = 0; leftIndex < p2.length; leftIndex += 1) {
    const left = p2[leftIndex];

    for (let rightIndex = leftIndex + 1; rightIndex < p2.length; rightIndex += 1) {
      const candidate = buildCandidate('p2_p2', left, p2[rightIndex]);
      if (candidate) candidates.push(candidate);
    }

    for (const right of p1) {
      const candidate = buildCandidate('p2_p1', left, right);
      if (candidate) candidates.push(candidate);
    }

    for (const right of p0) {
      const candidate = buildCandidate('p2_p0', left, right);
      if (candidate) candidates.push(candidate);
    }
  }

  return {
    counts: {
      p0: p0.length,
      p1: p1.length,
      p2: p2.length,
    },
    candidates: candidates.sort((left, right) => (
      Math.max(right.centroid_similarity, right.max_article_similarity)
      - Math.max(left.centroid_similarity, left.max_article_similarity)
    )),
  };
}

async function adjudicateCandidates(candidates) {
  if (candidates.length === 0) return [];
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required to validate P2 duplicates');
  }

  const tracing = startLangfuseTracing();
  const openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
    model: MODEL,
    category: CATEGORY,
    hours: HOURS,
    thresholds,
    candidateCount: candidates.length,
  }, {
    traceName: 'signalrss-p2-duplicate-validation',
    component: 'p2-duplicate-validator',
  });

  try {
    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: 'system',
          content: [
            'You validate whether two AI news clusters describe the same real-world news event.',
            'Pair types are p2_p2, p2_p1, and p2_p0.',
            'same_story means same event, announcement, deal, policy move, model release, incident, study, or lawsuit.',
            'related_but_distinct means same actors/theme but materially different event or angle.',
            'distinct means they are not the same story.',
            'insufficient_evidence means evidence is too weak to decide safely.',
            'Be conservative: do not merge broad thematic overlap.',
            'Return exactly one result for every candidate_id provided. Do not omit candidates.',
            'Return only structured JSON matching the schema.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            category: CATEGORY,
            hours: HOURS,
            thresholds,
            candidates,
          }),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'p2_duplicate_validation',
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
                  required: ['candidate_id', 'decision', 'confidence', 'rationale'],
                  properties: {
                    candidate_id: { type: 'string' },
                    decision: {
                      type: 'string',
                      enum: ['same_story', 'related_but_distinct', 'distinct', 'insufficient_evidence'],
                    },
                    confidence: { type: 'number' },
                    rationale: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    });

    console.log(`Langfuse tracing ${tracing.enabled ? 'enabled' : 'disabled'}`);
    return JSON.parse(responseText(response)).results || [];
  } finally {
    await shutdownLangfuseTracing().catch(() => {});
  }
}

async function main() {
  const clusters = await loadClusters();
  const { counts, candidates } = buildCandidates(clusters);
  const selected = candidates.slice(0, MAX_PAIRS);
  const candidateCounts = candidates.reduce((memo, candidate) => {
    memo[candidate.pair_type] = (memo[candidate.pair_type] || 0) + 1;
    return memo;
  }, {});

  console.log(JSON.stringify({
    cluster_counts: counts,
    thresholds,
    total_candidates: candidates.length,
    candidate_counts: candidateCounts,
    selected_for_llm: selected.length,
    top_candidates: selected.slice(0, 12).map((candidate) => ({
      pair_type: candidate.pair_type,
      centroid_similarity: candidate.centroid_similarity,
      max_article_similarity: candidate.max_article_similarity,
      left_cluster_id: candidate.left_cluster.cluster_id,
      right_cluster_id: candidate.right_cluster.cluster_id,
      left_title: candidate.left_cluster.title,
      right_title: candidate.right_cluster.title,
    })),
  }, null, 2));

  const results = await adjudicateCandidates(selected);
  const candidatesById = new Map(selected.map((candidate) => [candidate.candidate_id, candidate]));
  const sameStory = results
    .filter((result) => result.decision === 'same_story')
    .map((result) => ({
      ...result,
      candidate: candidatesById.get(result.candidate_id),
    }));

  console.log(JSON.stringify({
    llm_results: results.length,
    same_story_count: sameStory.length,
    same_story: sameStory.map((result) => ({
      pair_type: result.candidate?.pair_type,
      confidence: result.confidence,
      rationale: result.rationale,
      left_cluster_id: result.candidate?.left_cluster.cluster_id,
      right_cluster_id: result.candidate?.right_cluster.cluster_id,
      left_title: result.candidate?.left_cluster.title,
      right_title: result.candidate?.right_cluster.title,
      centroid_similarity: result.candidate?.centroid_similarity,
      max_article_similarity: result.candidate?.max_article_similarity,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
