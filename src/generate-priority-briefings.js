import crypto from 'node:crypto';
import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { geminiGenerationConfig } from './gemini-utils.js';
import { observeOpenAIClient, shutdownLangfuseTracing, startLangfuseTracing } from './langfuse.js';
import {
  cooldownSummary,
  getLlmCooldown,
  recordLlmFailure,
  recordLlmSuccess,
  reserveLlmProviderSlot,
} from './llm-cooldowns.js';
import { maxBatchSizeForLlmProvider } from './llm-provider-policy.js';
import { logLlmRequest } from './llm-request-log.js';
import { parseJsonObject, responseText, usageFromChatCompletion, usageFromOpenAIResponse } from './llm-utils.js';
import { priorityBriefingSettings } from './priority-config.js';
import { storyHashFromParts } from './story-hash.js';
import { cleanTextNoNull as cleanText, hashInput, sanitizeJsonValue } from './text-utils.js';
import { isBriefingExcluded } from './briefing-exclusions.js';

const WORKER_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

function categoryLabel(slug = '') {
  return cleanText(slug || 'tecnologia').replaceAll('-', ' ');
}

const PRIORITY_BRIEFING_GUIDANCE = {
  P0: {
    style: 'Decision-grade executive briefing. Lead with what changed, why it matters now, and the likely strategic consequence.',
    length: 'Use 2 concise paragraphs or one dense paragraph of roughly 90-150 words.',
    avoid: 'Do not dilute the brief with background trivia, generic hype, or article-by-article summaries.',
  },
  P1: {
    style: 'Executive monitoring briefing. Explain the signal, affected actors, and what should be watched next.',
    length: 'Use one or two concise paragraphs of roughly 70-130 words.',
    avoid: 'Do not overstate uncertainty as certainty or promote the story to crisis framing without evidence.',
  },
  P2: {
    style: 'Context briefing. Explain the useful technical or market context and why it is relevant but not urgent.',
    length: 'Use one concise paragraph of roughly 55-100 words.',
    avoid: 'Do not make it sound like a must-read story unless the evidence supports that.',
  },
  P3: {
    style: 'Low-priority briefing. Capture the useful takeaway only, if any, and keep it compact.',
    length: 'Use one compact paragraph of roughly 35-75 words.',
    avoid: 'Do not inflate routine, promotional, or tangential items.',
  },
};

const DEFAULT_CATEGORY_BRIEFING_GUIDANCE = {
  explain: [
    'What concretely happened.',
    'Who is affected.',
    'Why the cluster matters in the technology news context.',
  ],
  avoid: [
    'Unsupported claims, speculation, hype, and article-by-article recaps.',
    'Repeating the same fact multiple times just because multiple sources mention it.',
  ],
};

const CATEGORY_BRIEFING_GUIDANCE = {
  'artificial-intelligence': {
    explain: [
      'Model, product, capability, safety, compute, regulation, or enterprise-adoption implications.',
      'Whether this changes user behavior, developer workflows, platform power, cost, governance, or risk.',
    ],
    avoid: ['Generic AI hype and unsupported claims about AGI or disruption.'],
  },
  cybersecurity: {
    explain: [
      'Affected systems, exploitation status, threat actor or campaign when supported, and operational risk.',
      'Whether defenders, developers, cloud teams, or executives need immediate action.',
    ],
    avoid: ['Fear framing without evidence and vague vendor marketing.'],
  },
  'cloud-infrastructure': {
    explain: [
      'Capacity, reliability, AI compute, data center, networking, storage, pricing, sovereignty, or hyperscaler implications.',
      'Operational and strategic consequences for enterprises and builders.',
    ],
    avoid: ['Treating every local data center or partner announcement as broadly strategic.'],
  },
  semiconductors: {
    explain: [
      'Architecture, fab capacity, supply chain, export control, packaging, foundry, accelerator, or capex implications.',
      'Consequences for AI compute, devices, automotive, cloud, or geopolitical supply.',
    ],
    avoid: ['Stock-price-only framing unless tied to concrete technology or supply impact.'],
  },
  'software-development': {
    explain: [
      'Developer workflow, runtime, language, framework, browser, package ecosystem, tooling, security, or compatibility impact.',
      'Whether builders need to adopt, patch, migrate, or monitor.',
    ],
    avoid: ['Overstating routine release notes or minor library updates.'],
  },
  'consumer-electronics': {
    explain: [
      'Device platform, OS, ecosystem, hardware capability, safety, pricing, supply, or consumer adoption impact.',
      'Why the item matters beyond a product review or deal.',
    ],
    avoid: ['Buying-guide language, deal language, and rumor amplification.'],
  },
  'enterprise-technology': {
    explain: [
      'Enterprise software, SaaS, identity, data, ERP, CRM, collaboration, IT operations, spend, lock-in, or risk implications.',
      'Why CIOs or technology leaders should care.',
    ],
    avoid: ['Generic customer-win or partner-announcement language.'],
  },
  'startups-venture-capital': {
    explain: [
      'Funding, IPO, acquisition, shutdown, traction, market-structure, or ecosystem implications.',
      'Why this startup event is a signal rather than isolated financing news.',
    ],
    avoid: ['Founder-profile fluff and valuation hype without evidence.'],
  },
  'science-research': {
    explain: [
      'Research credibility, mechanism, potential application, time horizon, and uncertainty.',
      'Whether the result changes technical feasibility or strategic direction.',
    ],
    avoid: ['Sensational claims beyond the evidence.'],
  },
  'policy-regulation': {
    explain: [
      'Regulatory obligation, enforcement, court, export control, antitrust, privacy, safety, or procurement implications.',
      'Who must change behavior and by when if the evidence says so.',
    ],
    avoid: ['Political commentary without operational technology consequence.'],
  },
  gaming: {
    explain: [
      'Platform, engine, storefront, subscription, console, cloud gaming, developer economy, or distribution implications.',
      'Whether the story matters beyond entertainment coverage.',
    ],
    avoid: ['Review, trailer, esports, gossip, or gambling framing unless technically relevant.'],
  },
  'automotive-mobility': {
    explain: [
      'EV, autonomy, battery, charging, software-defined vehicle, safety, regulation, production, or supply-chain implications.',
      'Consequences for mobility platforms, infrastructure, or adoption.',
    ],
    avoid: ['Car-review language and routine trim/model-year details.'],
  },
  'fintech-crypto': {
    explain: [
      'Payments, banking, stablecoin, custody, exchange, fraud, compliance, or market-infrastructure implications.',
      'Consequences for institutions, users, regulators, or enterprise adoption.',
    ],
    avoid: ['Price-only crypto framing and promotional partnership language.'],
  },
  'crypto-web3': {
    explain: [
      'Protocol, wallet, exchange, stablecoin, custody, exploit, scaling, governance, or regulatory implications.',
      'Developer, security, market-infrastructure, or adoption consequences.',
    ],
    avoid: ['NFT-drop, memecoin, or ecosystem-promo framing unless it has broader consequence.'],
  },
};

function briefingGuidanceOverrides() {
  if (!config.briefingCategoryGuidanceJson) return {};
  try {
    const parsed = JSON.parse(config.briefingCategoryGuidanceJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`Ignoring invalid BRIEFING_CATEGORY_GUIDANCE_JSON: ${error.message}`);
    return {};
  }
}

const CATEGORY_BRIEFING_GUIDANCE_OVERRIDES = briefingGuidanceOverrides();

function guidanceSlugForClusters(settings, clusters) {
  if (settings.categorySlug) return settings.categorySlug;
  const slugs = [...new Set(clusters.map((cluster) => cluster.category_slug).filter(Boolean))];
  return slugs.length === 1 ? slugs[0] : 'all';
}

function mergeCategoryBriefingGuidance(categorySlug) {
  const overlay = {
    ...(CATEGORY_BRIEFING_GUIDANCE[categorySlug] || {}),
    ...(CATEGORY_BRIEFING_GUIDANCE_OVERRIDES[categorySlug] || {}),
  };
  return {
    explain: [...DEFAULT_CATEGORY_BRIEFING_GUIDANCE.explain, ...(overlay.explain || [])],
    avoid: [...DEFAULT_CATEGORY_BRIEFING_GUIDANCE.avoid, ...(overlay.avoid || [])],
  };
}

async function ensureBriefingClaimsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cluster_briefing_claims (
      cluster_id uuid NOT NULL,
      locale text NOT NULL,
      briefing_type text NOT NULL,
      locked_by text NOT NULL,
      locked_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (cluster_id, locale, briefing_type)
    )
  `);
}

async function cleanupStaleBriefingClaims() {
  await ensureBriefingClaimsTable();
  await pool.query(`
    DELETE FROM cluster_briefing_claims
    WHERE locked_at < NOW() - ($1::int * INTERVAL '1 minute')
  `, [config.briefingClaimStaleMinutes]);
}

export async function cleanupBriefingClaimsOlderThan(minutes = config.briefingClaimStaleMinutes) {
  await ensureBriefingClaimsTable();
  const lockMinutes = Math.max(1, Number(minutes) || config.briefingClaimStaleMinutes);
  const { rowCount } = await pool.query(`
    DELETE FROM cluster_briefing_claims
    WHERE locked_at < NOW() - ($1::int * INTERVAL '1 minute')
  `, [lockMinutes]);
  return rowCount;
}

async function claimBriefingClusters(settings, clusters) {
  if (clusters.length === 0) return [];
  await ensureBriefingClaimsTable();

  const ids = clusters.map((cluster) => cluster.id);
  const { rows } = await pool.query(`
    INSERT INTO cluster_briefing_claims (
      cluster_id,
      locale,
      briefing_type,
      locked_by,
      locked_at
    )
    SELECT unnest($1::uuid[]), $2, $3, $4, NOW()
    ON CONFLICT (cluster_id, locale, briefing_type) DO UPDATE SET
      locked_by = EXCLUDED.locked_by,
      locked_at = EXCLUDED.locked_at
    WHERE cluster_briefing_claims.locked_at < NOW() - ($5::int * INTERVAL '1 minute')
    RETURNING cluster_id
  `, [
    ids,
    settings.locale,
    settings.briefingType,
    WORKER_ID,
    config.briefingClaimStaleMinutes,
  ]);

  const claimedIds = new Set(rows.map((row) => row.cluster_id));
  return clusters.filter((cluster) => claimedIds.has(cluster.id));
}

async function releaseBriefingClaims(settings, clusterIds) {
  if (clusterIds.length === 0) return;
  await pool.query(`
    DELETE FROM cluster_briefing_claims
    WHERE cluster_id = ANY($1::uuid[])
      AND locale = $2
      AND briefing_type = $3
      AND locked_by = $4
  `, [clusterIds, settings.locale, settings.briefingType, WORKER_ID]);
}

function briefingLinks(cluster) {
  return (cluster.articles || []).map((article) => ({
    title: cleanText(article.title).slice(0, 260),
    url: article.url,
    source: article.source,
    published_at: article.published_at,
  })).filter((article) => article.url);
}

function clusterInput(cluster) {
  return {
    cluster_id: cluster.id,
    original_title: cleanText(cluster.title).slice(0, 260),
    impact_level: cluster.impact_level,
    impact_score: Number(cluster.impact_score || 0),
    impact_category: cluster.impact_category,
    impact_summary: cleanText(cluster.impact_summary).slice(0, 900),
    why_it_matters: cleanText(cluster.why_it_matters).slice(0, 1000),
    impact_reasons: Array.isArray(cluster.impact_reasons) ? cluster.impact_reasons : [],
    article_count: Number(cluster.article_count || 0),
    source_count: Number(cluster.source_count || 0),
    latest_published_at: cluster.latest_published_at,
    links: briefingLinks(cluster),
    evidence: (cluster.articles || []).slice(0, 8).map((article) => ({
      title: cleanText(article.title).slice(0, 240),
      source: article.source,
      summary: cleanText(article.summary).slice(0, 800),
      published_at: article.published_at,
    })),
  };
}

function inputHash(settings, cluster) {
  return hashInput(JSON.stringify({
    version: settings.version,
    model: settings.model,
    model_fallbacks: config.briefingModelFallbacks,
    cluster: clusterInput(cluster),
  }));
}

function fallbackSpecs(settings) {
  const allowOpenAi = config.briefingOpenAiFallbackLevels.includes(settings.level);
  const fallbacks = config.briefingModelFallbacks.length > 0
    ? config.briefingModelFallbacks
    : [`openai:${settings.model}`];
  return fallbacks.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) return { provider: 'openai', model: entry };
    return {
      provider: entry.slice(0, separator),
      model: entry.slice(separator + 1),
    };
  }).filter((spec) => spec.provider && spec.model)
    .filter((spec) => spec.provider !== 'openai' || allowOpenAi);
}

function fallbackSpecLabel(settings) {
  return fallbackSpecs(settings)
    .map((spec) => `${spec.provider}:${spec.model}`)
    .join(',');
}

function briefingMessages(settings, category, clusters) {
  const categorySlug = guidanceSlugForClusters(settings, clusters);
  const categoryGuidance = categorySlug === 'all'
    ? { note: 'Mixed-category batch. Use each cluster category and avoid forcing a single domain frame across unrelated stories.' }
    : mergeCategoryBriefingGuidance(categorySlug);
  const priorityGuidance = PRIORITY_BRIEFING_GUIDANCE[settings.level] || PRIORITY_BRIEFING_GUIDANCE.P2;

  return [
    {
      role: 'system',
      content: [
        `You write executive news briefings for ${settings.level} ${category} technology news clusters.`,
        `Write the briefing title and summary in ${config.briefingOutputLanguage}.`,
        'Synthesize the whole cluster as one story. Do not summarize article-by-article.',
        'Use only the provided evidence. Do not invent facts, numbers, dates, causality, or named actors.',
        'Explain what happened, why it matters, and the practical consequence for an executive technology reader.',
        'Do not include links in the title or summary; links are appended by the application.',
        'Return only compact valid JSON with this shape: {"results":[{"cluster_id":"...","title_es":"...","summary_es":"..."}]}.',
        'Keep the JSON field names title_es and summary_es for schema compatibility even when the output language is not Spanish.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        version: settings.version,
        output_language: config.briefingOutputLanguage,
        priority_guidance: priorityGuidance,
        category_guidance_slug: categorySlug,
        category_guidance: categoryGuidance,
        clusters: clusters.map(clusterInput),
      }),
    },
  ];
}

function briefingJsonSchema() {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cluster_id: { type: 'string' },
            title_es: { type: 'string' },
            summary_es: { type: 'string' },
          },
          required: ['cluster_id', 'title_es', 'summary_es'],
        },
      },
    },
    required: ['results'],
  };
}

function geminiPromptFromMessages(messages) {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
    .join('\n\n');
}

function usageFromGeminiNative(body = {}) {
  const usage = body.usageMetadata || {};
  const input = Number(usage.promptTokenCount || 0);
  const output = Number(usage.candidatesTokenCount || 0);
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: Number(usage.totalTokenCount || input + output),
    cachedTokens: Number(usage.cachedContentTokenCount || 0),
    reasoningTokens: Number(usage.thoughtsTokenCount || 0),
    costUsd: 0,
  };
}

async function createGeminiBriefings({ model, settings, category, clusters }) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is required for Gemini briefing fallback');
  const response = await fetch(
    `${config.geminiNativeBaseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(config.geminiRequestTimeoutMs),
      headers: {
        'x-goog-api-key': config.geminiApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: geminiPromptFromMessages(briefingMessages(settings, category, clusters)) }],
        }],
        generationConfig: geminiGenerationConfig({
          model,
          maxOutputTokens: 1800,
          responseJsonSchema: briefingJsonSchema(),
        }),
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${raw.slice(0, 700)}`);
  const body = JSON.parse(raw);
  const content = (body.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('');
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('Gemini response missing results array');
  return {
    parsed,
    resolvedModel: model,
    usage: usageFromGeminiNative(body),
  };
}

function githubSupportsJsonSchema(model) {
  return String(model || '').startsWith('openai/');
}

async function createChatBriefings({ provider, model, settings, category, clusters }) {
  if (provider === 'gemini') {
    return createGeminiBriefings({ model, settings, category, clusters });
  }

  let url;
  let headers = { 'content-type': 'application/json' };
  let timeoutMs = 45000;
  const body = {
    model,
    messages: briefingMessages(settings, category, clusters),
    temperature: 0.1,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    stream: false,
  };

  if (provider === 'nvidia') {
    if (!config.nvidiaApiKey) throw new Error('NVIDIA_API_KEY is required for NVIDIA briefing fallback');
    url = `${config.nvidiaBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    headers.authorization = `Bearer ${config.nvidiaApiKey}`;
    timeoutMs = config.nvidiaRequestTimeoutMs;
  } else if (provider === 'groq') {
    if (!config.groqApiKey) throw new Error('GROQ_API_KEY is required for Groq briefing fallback');
    url = `${config.groqBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.groqApiKey}`;
    timeoutMs = config.groqRequestTimeoutMs;
  } else if (provider === 'cerebras') {
    if (!config.cerebrasApiKey) throw new Error('CEREBRAS_API_KEY is required for Cerebras briefing fallback');
    url = `${config.cerebrasBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.cerebrasApiKey}`;
    timeoutMs = config.cerebrasRequestTimeoutMs;
  } else if (provider === 'sambanova') {
    if (!config.sambanovaApiKey) throw new Error('SAMBANOVA_API_KEY is required for SambaNova briefing fallback');
    url = `${config.sambanovaBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.sambanovaApiKey}`;
    timeoutMs = config.sambanovaRequestTimeoutMs;
  } else if (provider === 'mistral') {
    if (!config.mistralApiKey) throw new Error('MISTRAL_API_KEY is required for Mistral briefing fallback');
    url = `${config.mistralBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.mistralApiKey}`;
    timeoutMs = config.mistralRequestTimeoutMs;
  } else if (provider === 'llmrack') {
    if (!config.llmRackApiKey) throw new Error('LLMRACK_API_KEY is required for LLMRack briefing fallback');
    url = `${config.llmRackBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.llmRackApiKey}`;
    timeoutMs = config.llmRackRequestTimeoutMs;
  } else if (provider === 'github') {
    if (!config.githubModelsToken) throw new Error('GITHUB_MODELS_TOKEN is required for GitHub Models briefing fallback');
    url = `${config.githubModelsBaseUrl.replace(/\/$/, '')}/chat/completions`;
    headers = {
      ...headers,
      authorization: `Bearer ${config.githubModelsToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
    };
    timeoutMs = config.githubModelsRequestTimeoutMs;
    body.response_format = githubSupportsJsonSchema(model)
      ? {
          type: 'json_schema',
          json_schema: {
            name: settings.schemaName,
            schema: briefingJsonSchema(),
          },
        }
      : { type: 'json_object' };
  } else if (provider === 'cloudflare') {
    if (!config.cloudflareApiToken) throw new Error('CLOUDFLARE_API_TOKEN is required for Cloudflare briefing fallback');
    if (!config.cloudflareAccountId && !config.cloudflareBaseUrl) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BASE_URL is required for Cloudflare briefing fallback');
    }
    const baseUrl = config.cloudflareBaseUrl
      || `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/v1`;
    url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.cloudflareApiToken}`;
    timeoutMs = config.cloudflareRequestTimeoutMs;
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: settings.schemaName,
        schema: briefingJsonSchema(),
      },
    };
  } else if (provider === 'openrouter') {
    if (!config.openRouterApiKey) throw new Error('OPENROUTER_API_KEY is required for OpenRouter briefing fallback');
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers = {
      ...headers,
      authorization: `Bearer ${config.openRouterApiKey}`,
      ...(config.openRouterReferer ? { 'http-referer': config.openRouterReferer } : {}),
      'x-title': config.openRouterTitle,
    };
    timeoutMs = config.openRouterRequestTimeoutMs;
    if (model.includes('nemotron-3-super')) body.reasoning = { enabled: false };
  } else {
    throw new Error(`Unsupported briefing provider: ${provider}`);
  }

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${provider} ${response.status}: ${raw.slice(0, 700)}`);

  const parsedBody = JSON.parse(raw);
  const content = parsedBody.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error(`${provider} response missing results array`);
  return {
    parsed,
    resolvedModel: parsedBody.model || model,
    usage: usageFromChatCompletion(parsedBody),
  };
}

async function loadCandidateClusters(settings) {
  if (isBriefingExcluded(settings.categorySlug, settings.level)) return [];
  await cleanupStaleBriefingClaims();

  const queryLimit = Math.max(settings.batchSize * settings.queryLimitMultiplier, settings.minQueryLimit);
  const params = [
    settings.windowHours,
    settings.locale,
    settings.briefingType,
    queryLimit,
    settings.level,
  ];
  let categoryFilter = '';
  let minPublishedAtFilter = '';

  if (settings.minPublishedAt) {
    params.push(settings.minPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  if (settings.categorySlug) {
    params.push(settings.categorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rows } = await pool.query(`
    WITH priority_clusters AS (
      SELECT
        sc.id,
        sc.title,
        sc.article_count,
        sc.latest_published_at,
        tc.slug AS category_slug,
        cis.impact_level,
        cis.impact_score,
        cis.impact_category,
        cis.summary AS impact_summary,
        cis.why_it_matters,
        cis.impact_reasons,
        cb.input_hash AS existing_input_hash,
        count(DISTINCT a.source_host)::int AS source_count,
        json_agg(
          json_build_object(
            'title', a.title,
            'url', a.canonical_url,
            'published_at', a.published_at,
            'summary', a.summary,
            'source', a.source_host
          )
          ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
        ) AS articles
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      JOIN cluster_articles ca ON ca.cluster_id = sc.id
      JOIN articles a ON a.id = ca.article_id
      LEFT JOIN cluster_briefings cb
        ON cb.cluster_id = sc.id
        AND cb.locale = $2
        AND cb.briefing_type = $3
      WHERE cis.impact_level = $5
        AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
        ${minPublishedAtFilter}
        AND sc.latest_published_at <= NOW()
        ${categoryFilter}
      GROUP BY sc.id, tc.slug, cis.cluster_id, cb.input_hash
    )
    SELECT *
    FROM priority_clusters
    ORDER BY impact_score DESC, latest_published_at DESC
    LIMIT $4
  `, params);

  const candidates = rows
    .map((cluster) => ({
      ...cluster,
      computed_input_hash: inputHash(settings, cluster),
    }))
    .filter((cluster) => cluster.existing_input_hash !== cluster.computed_input_hash);

  for (let index = 0; index < candidates.length; index += settings.batchSize) {
    const claimed = await claimBriefingClusters(settings, candidates.slice(index, index + settings.batchSize));
    if (claimed.length > 0) return claimed;
  }

  return [];
}

async function generateBriefings(getOpenAI, settings, clusters) {
  if (clusters.length === 0) return [];

  const category = categoryLabel(settings.categorySlug || clusters[0]?.category_slug);
  let parsed = null;
  let winner = null;
  const errors = [];

  for (const spec of fallbackSpecs(settings)) {
    const started = Date.now();
    const operation = 'briefing_generation';
    const maxBatchSize = maxBatchSizeForLlmProvider({
      provider: spec.provider,
      model: spec.model,
      operation,
    });
    if (maxBatchSize && clusters.length > maxBatchSize) {
      errors.push(`${spec.provider}:${spec.model}: skipped batch ${clusters.length} > max ${maxBatchSize}`);
      continue;
    }

    const slot = await reserveLlmProviderSlot({
      provider: spec.provider,
      model: spec.model,
      operation,
    });
    const cooldown = slot.cooldown;
    if (cooldown) {
      errors.push(`${spec.provider}:${spec.model}: cooldown ${cooldownSummary(cooldown)}`);
      continue;
    }

    try {
      if (spec.provider === 'openai') {
        const openai = getOpenAI();
        if (!openai) throw new Error('OPENAI_API_KEY is required for OpenAI briefing fallback');
        const response = await openai.responses.create({
          model: spec.model,
          input: briefingMessages(settings, category, clusters),
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
                      required: ['cluster_id', 'title_es', 'summary_es'],
                      properties: {
                        cluster_id: { type: 'string' },
                        title_es: { type: 'string' },
                        summary_es: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        parsed = JSON.parse(responseText(response));
        const resolvedModel = response.model || spec.model;
        await recordLlmSuccess({ provider: spec.provider, model: spec.model, operation });
        await logLlmRequest({
          operation,
          provider: spec.provider,
          requestedModel: spec.model,
          resolvedModel,
          status: 'ok',
          categorySlug: settings.categorySlug || clusters[0]?.category_slug || null,
          batchSize: clusters.length,
          usage: usageFromOpenAIResponse(response),
          latencyMs: Date.now() - started,
          metadata: { worker_id: WORKER_ID, impact_level: settings.level },
        });
        winner = { provider: spec.provider, model: resolvedModel };
      } else {
        const result = await createChatBriefings({
          provider: spec.provider,
          model: spec.model,
          settings,
          category,
          clusters,
        });
        parsed = result.parsed;
        const resolvedModel = result.resolvedModel || spec.model;
        await recordLlmSuccess({ provider: spec.provider, model: spec.model, operation });
        await logLlmRequest({
          operation,
          provider: spec.provider,
          requestedModel: spec.model,
          resolvedModel,
          status: 'ok',
          categorySlug: settings.categorySlug || clusters[0]?.category_slug || null,
          batchSize: clusters.length,
          usage: result.usage,
          latencyMs: Date.now() - started,
          metadata: { worker_id: WORKER_ID, impact_level: settings.level },
        });
        winner = { provider: spec.provider, model: resolvedModel };
      }
      break;
    } catch (error) {
      await recordLlmFailure({
        provider: spec.provider,
        model: spec.model,
        operation,
        error,
      });
      await logLlmRequest({
        operation,
        provider: spec.provider,
        requestedModel: spec.model,
        status: 'failed',
        categorySlug: settings.categorySlug || clusters[0]?.category_slug || null,
        batchSize: clusters.length,
        latencyMs: Date.now() - started,
        error: error.message,
        metadata: { worker_id: WORKER_ID, impact_level: settings.level },
      });
      errors.push(`${spec.provider}:${spec.model}: ${error.message}`);
      console.warn(`${settings.level} briefing fallback failed provider=${spec.provider} model=${spec.model}: ${error.message}`);
    }
  }

  if (!parsed || !winner) {
    throw new Error(`All ${settings.level} briefing fallbacks failed: ${errors.join(' | ')}`);
  }

  const expectedIds = new Set(clusters.map((cluster) => cluster.id));
  const uniqueResults = new Map();
  for (const result of parsed.results || []) {
    if (expectedIds.has(result.cluster_id) && !uniqueResults.has(result.cluster_id)) {
      uniqueResults.set(result.cluster_id, {
        ...result,
        model: winner.model,
      });
    }
  }
  return [...uniqueResults.values()];
}

async function saveBriefings(settings, clusters, briefings) {
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  let saved = 0;

  for (const briefing of briefings) {
    const cluster = clustersById.get(briefing.cluster_id);
    if (!cluster) continue;

    const links = sanitizeJsonValue(briefingLinks(cluster));
    const storyHash = storyHashFromParts({ links, title: briefing.title_es || cluster.title });
    const payload = {
      cluster_id: cluster.id,
      locale: settings.locale,
      briefing_type: settings.briefingType,
      impact_level: cluster.impact_level,
      impact_score: cluster.impact_score,
      impact_category: cluster.impact_category,
      title: cleanText(briefing.title_es).slice(0, 300),
      summary: cleanText(briefing.summary_es).slice(0, 1800),
      links,
      story_hash: storyHash,
      generated_at: new Date().toISOString(),
    };
    const sanitizedPayload = sanitizeJsonValue(payload);

    const { rowCount } = await pool.query(
      `INSERT INTO cluster_briefings (
         cluster_id,
         locale,
         briefing_type,
         title,
         summary,
         links,
         payload,
         model,
         input_hash,
         story_hash,
         generated_at,
         updated_at
       )
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, NOW(), NOW()
       WHERE EXISTS (SELECT 1 FROM story_clusters WHERE id = $1)
       ON CONFLICT (cluster_id, locale, briefing_type) DO UPDATE SET
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         links = EXCLUDED.links,
         payload = EXCLUDED.payload,
         model = EXCLUDED.model,
         input_hash = EXCLUDED.input_hash,
         story_hash = EXCLUDED.story_hash,
         generated_at = NOW(),
         updated_at = NOW()`,
      [
        cluster.id,
        settings.locale,
        settings.briefingType,
        sanitizedPayload.title,
        sanitizedPayload.summary,
        JSON.stringify(links),
        JSON.stringify(sanitizedPayload),
        briefing.model || settings.model,
        cluster.computed_input_hash,
        storyHash,
      ],
    );
    saved += rowCount;
  }

  return saved;
}

export async function runPriorityBriefings(
  level,
  { closeConnections = true, runUntilEmpty, maxBatches = 1, categorySlug, batchSizeOverride } = {},
) {
  const baseSettings = priorityBriefingSettings(level, { categorySlug });
  if (isBriefingExcluded(baseSettings.categorySlug, baseSettings.level)) {
    console.log(`Briefing skipped category=${baseSettings.categorySlug} level=${baseSettings.level}: excluded by CATEGORY_BRIEFING_EXCLUDE_LEVELS`);
    return;
  }
  const settings = batchSizeOverride
    ? { ...baseSettings, batchSize: Math.max(1, Number(batchSizeOverride) || baseSettings.batchSize) }
    : baseSettings;
  const shouldRunUntilEmpty = runUntilEmpty ?? settings.runUntilEmpty;

  const fallbackProviders = new Set(fallbackSpecs(settings).map((spec) => spec.provider));
  if (fallbackProviders.has('openai') && !config.openaiApiKey) {
    throw new Error(`OPENAI_API_KEY is required because ${settings.level} briefing fallbacks include openai`);
  }
  if (fallbackProviders.has('openrouter') && !config.openRouterApiKey) {
    throw new Error(`OPENROUTER_API_KEY is required because ${settings.level} briefing fallbacks include openrouter`);
  }
  if (fallbackProviders.has('nvidia') && !config.nvidiaApiKey) {
    throw new Error(`NVIDIA_API_KEY is required because ${settings.level} briefing fallbacks include nvidia`);
  }
  if (fallbackProviders.has('groq') && !config.groqApiKey) {
    throw new Error(`GROQ_API_KEY is required because ${settings.level} briefing fallbacks include groq`);
  }
  if (fallbackProviders.has('cerebras') && !config.cerebrasApiKey) {
    throw new Error(`CEREBRAS_API_KEY is required because ${settings.level} briefing fallbacks include cerebras`);
  }
  if (fallbackProviders.has('sambanova') && !config.sambanovaApiKey) {
    throw new Error(`SAMBANOVA_API_KEY is required because ${settings.level} briefing fallbacks include sambanova`);
  }
  if (fallbackProviders.has('mistral') && !config.mistralApiKey) {
    throw new Error(`MISTRAL_API_KEY is required because ${settings.level} briefing fallbacks include mistral`);
  }
  if (fallbackProviders.has('llmrack') && !config.llmRackApiKey) {
    throw new Error(`LLMRACK_API_KEY is required because ${settings.level} briefing fallbacks include llmrack`);
  }
  if (fallbackProviders.has('github') && !config.githubModelsToken) {
    throw new Error(`GITHUB_MODELS_TOKEN is required because ${settings.level} briefing fallbacks include github`);
  }
  if (fallbackProviders.has('cloudflare') && !config.cloudflareApiToken) {
    throw new Error(`CLOUDFLARE_API_TOKEN is required because ${settings.level} briefing fallbacks include cloudflare`);
  }
  if (fallbackProviders.has('gemini') && !config.geminiApiKey) {
    throw new Error(`GEMINI_API_KEY is required because ${settings.level} briefing fallbacks include gemini`);
  }

  let tracing = null;
  let openai = null;

  function ensureOpenAI() {
    if (!fallbackProviders.has('openai')) return null;
    if (openai) return openai;
    tracing = startLangfuseTracing();
    openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
      briefingModel: settings.model,
      briefingBatchSize: settings.batchSize,
      briefingCategorySlug: settings.categorySlug,
      briefingWindowHours: settings.windowHours,
      impactLevel: settings.level,
    }, {
      traceName: settings.traceName,
      component: settings.component,
    });
    return openai;
  }

  try {
    let considered = 0;
    let generated = 0;
    let batch = 0;
    const batchLimit = shouldRunUntilEmpty
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Number(maxBatches) || 1);

    do {
      batch += 1;
      const clusters = await loadCandidateClusters(settings);
      if (clusters.length === 0) {
        console.log(`${settings.level} briefing batch ${batch}: generated 0/0`);
        break;
      }

      try {
        const briefings = await generateBriefings(ensureOpenAI, settings, clusters);
        const saved = await saveBriefings(settings, clusters, briefings);
        considered += clusters.length;
        generated += saved;
        console.log(`${settings.level} briefing batch ${batch}: generated ${saved}/${clusters.length}`);
      } finally {
        await releaseBriefingClaims(settings, clusters.map((cluster) => cluster.id));
      }
    } while (batch < batchLimit);

    console.log(`Generated ${generated}/${considered} ${settings.level} briefings with fallbacks ${fallbackSpecLabel(settings)}`);
    console.log(`Langfuse tracing ${tracing?.enabled ? 'enabled' : 'not started'}`);
  } finally {
    if (tracing) await shutdownLangfuseTracing().catch(() => {});
    if (closeConnections) await closeDb();
  }
}

export async function hasPriorityBriefingWork(level, { categorySlug } = {}) {
  const settings = priorityBriefingSettings(level, { categorySlug });
  if (isBriefingExcluded(settings.categorySlug, settings.level)) return false;
  const params = [
    settings.windowHours,
    settings.level,
    settings.locale,
    settings.briefingType,
  ];
  let categoryFilter = '';
  let minPublishedAtFilter = '';

  if (settings.minPublishedAt) {
    params.push(settings.minPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  if (settings.categorySlug) {
    params.push(settings.categorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  const { rowCount } = await pool.query(`
    SELECT 1
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    LEFT JOIN cluster_briefings cb
      ON cb.cluster_id = sc.id
      AND cb.locale = $3
      AND cb.briefing_type = $4
    WHERE cis.impact_level = $2
      AND sc.latest_published_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ${minPublishedAtFilter}
      AND sc.latest_published_at <= NOW()
      AND (
        cb.cluster_id IS NULL
        OR cb.updated_at < sc.updated_at
        OR cb.updated_at < cis.updated_at
      )
      ${categoryFilter}
    LIMIT 1
  `, params);

  return rowCount > 0;
}

export async function hasPriorityBriefingProviderAvailable(level, { categorySlug } = {}) {
  return (await availablePriorityBriefingProviders(level, { categorySlug })).length > 0;
}

export async function availablePriorityBriefingProviders(level, { categorySlug } = {}) {
  const settings = priorityBriefingSettings(level, { categorySlug });
  if (isBriefingExcluded(settings.categorySlug, settings.level)) return [];
  const operation = 'briefing_generation';
  const available = [];

  for (const spec of fallbackSpecs(settings)) {
    const cooldown = await getLlmCooldown({
      provider: spec.provider,
      model: spec.model,
      operation,
    });
    if (!cooldown) available.push(spec);
  }

  return available;
}
