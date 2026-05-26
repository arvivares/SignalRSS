import os from 'node:os';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { config } from './config.js';
import { pool, closeDb } from './db.js';
import { geminiGenerationConfig } from './gemini-utils.js';
import {
  cooldownSummary,
  recordLlmFailure,
  recordLlmSuccess,
  reserveLlmProviderSlot,
} from './llm-cooldowns.js';
import { llmProviderEnabled, maxBatchSizeForLlmProvider } from './llm-provider-policy.js';
import { logLlmRequest } from './llm-request-log.js';
import {
  parseJsonObject,
  responseText,
  usageFromChatCompletion,
  usageFromOpenAIResponse,
} from './llm-utils.js';
import { cleanText, hashInput, hostFromUrl } from './text-utils.js';
import { isBriefingExcluded } from './briefing-exclusions.js';
import { capImpactForEvidence } from './evidence-quality.js';
import { impactEligibilitySql, impactMaxClusterAgeExpression, impactWindowHoursExpression } from './impact-eligibility.js';
import {
  observeOpenAIClient,
  shutdownLangfuseTracing,
  startLangfuseGeneration,
  startLangfuseTracing,
} from './langfuse.js';

const RUBRIC_VERSION = process.env.IMPACT_RUBRIC_VERSION || 'impact-v2';
const WORKER_ID = process.env.IMPACT_WORKER_ID || `${os.hostname()}-${process.pid}`;

const IMPACT_CATEGORIES = [
  'breakthrough',
  'business',
  'infrastructure',
  'product',
  'policy',
  'security-risk',
  'developer-impact',
  'societal-impact',
  'research',
  'market',
  'noise',
];

const DEFAULT_CATEGORY_GUIDANCE = {
  p0_signals: [
    'Broad consequence across major technology buyers, builders, markets, regulation, infrastructure, or security posture.',
    'Clear novelty versus routine product, funding, partnership, benchmark, or opinion coverage.',
    'Independent evidence from authoritative sources, or a single authoritative source reporting a materially urgent event.',
  ],
  p1_signals: [
    'Important story for the category, but narrower, earlier, or less certain than P0.',
    'Material product, policy, market, infrastructure, developer, or security signal worth monitoring today.',
  ],
  downrank_signals: [
    'Routine release note, promotional announcement, generic listicle, personal how-to, minor deal, rumor, or weakly substantiated claim.',
    'Multiple articles repeating the same syndicated content without independent evidence.',
  ],
};

const CATEGORY_IMPACT_GUIDANCE = {
  'artificial-intelligence': {
    p0_signals: [
      'Major frontier model, default assistant, AI platform, agentic system, safety, compute, regulation, or enterprise adoption shift.',
      'Material AI capability, governance, pricing, access, liability, or deployment change affecting many users or developers.',
    ],
    downrank_signals: [
      'Prompt tips, personal experiments, narrow app integrations, generic AI commentary, or single-vendor promotion without adoption evidence.',
    ],
  },
  cybersecurity: {
    p0_signals: [
      'Active exploitation, ransomware campaign, critical vulnerability in widely deployed software, major breach, credential exposure, or state-linked activity.',
      'Security event requiring urgent operational response by enterprises, governments, developers, or cloud operators.',
    ],
    downrank_signals: [
      'Routine patch notes, generic vendor blogs, minor bug bounty posts, vague threat research, or security-adjacent business news.',
    ],
  },
  'cloud-infrastructure': {
    p0_signals: [
      'Large-scale cloud capacity, outage, pricing, GPU/AI infrastructure, hyperscaler strategy, sovereignty, networking, storage, or data center shift.',
      'Infrastructure event with broad enterprise, developer, AI compute, or regional availability consequences.',
    ],
    downrank_signals: [
      'Narrow feature announcements, local data center marketing, partner press releases, or vendor tutorials without broad operational impact.',
    ],
  },
  semiconductors: {
    p0_signals: [
      'Major chip architecture, fab capacity, export control, supply chain, packaging, lithography, foundry, GPU/accelerator, or capex shift.',
      'Material consequences for AI compute, consumer devices, automotive, defense, cloud infrastructure, or global supply.',
    ],
    downrank_signals: [
      'Routine earnings commentary, minor product SKU updates, speculative stock movement, or local investment with unclear capacity impact.',
    ],
  },
  'software-development': {
    p0_signals: [
      'Major language, framework, runtime, browser, package ecosystem, developer tooling, supply-chain, or platform change affecting many developers.',
      'Breaking change, security issue, licensing shift, or deprecation with broad production impact.',
    ],
    downrank_signals: [
      'Routine version releases, small library updates, tutorials, opinion posts, or changelogs without meaningful adoption or compatibility impact.',
    ],
  },
  'consumer-electronics': {
    p0_signals: [
      'Major device platform, operating system, hardware category, safety issue, pricing, supply, or ecosystem change affecting large consumer markets.',
      'Product shift with clear strategic consequences beyond a routine launch.',
    ],
    downrank_signals: [
      'Deals, accessories, minor firmware updates, rumors, buying guides, or single-market availability notes.',
    ],
  },
  'enterprise-technology': {
    p0_signals: [
      'Major enterprise software, SaaS, identity, data, ERP, CRM, collaboration, IT operations, or procurement shift.',
      'Material change affecting CIO priorities, enterprise risk, spend, vendor lock-in, or productivity at scale.',
    ],
    downrank_signals: [
      'Customer wins, minor integrations, routine analyst commentary, or vendor marketing without measurable enterprise impact.',
    ],
  },
  'startups-venture-capital': {
    p0_signals: [
      'Large financing, IPO, shutdown, acquisition, regulatory action, or product traction that signals a market structure change.',
      'Startup event with implications for AI, infrastructure, security, fintech, semiconductors, or enterprise technology ecosystems.',
    ],
    downrank_signals: [
      'Small funding rounds, accelerator announcements, founder profiles, or speculative commentary without category-level signal.',
    ],
  },
  'science-research': {
    p0_signals: [
      'Peer-reviewed or institutionally credible breakthrough with plausible technology, health, energy, materials, compute, or policy implications.',
      'Research result that changes technical feasibility, risk assessment, or near-term strategic direction.',
    ],
    downrank_signals: [
      'Early-stage animal studies, preprints without validation, sensational science headlines, or incremental academic results.',
    ],
  },
  'policy-regulation': {
    p0_signals: [
      'Binding regulation, enforcement, court ruling, export control, antitrust action, privacy/safety mandate, or government procurement shift.',
      'Policy event that changes obligations, access, market structure, compliance cost, or deployment risk.',
    ],
    downrank_signals: [
      'Political commentary, non-binding proposals, speeches, consultations, or local actions without broader technology impact.',
    ],
  },
  gaming: {
    p0_signals: [
      'Major platform, engine, storefront, console, cloud gaming, antitrust, developer economy, or safety change affecting the gaming ecosystem.',
      'Gaming story with broader implications for consumer platforms, GPUs, subscriptions, creator tools, or digital distribution.',
    ],
    downrank_signals: [
      'Trailers, reviews, esports results, routine game updates, entertainment gossip, or gambling content.',
    ],
  },
  'automotive-mobility': {
    p0_signals: [
      'Major EV, autonomy, battery, charging, software-defined vehicle, safety recall, regulation, or supply-chain shift.',
      'Mobility event affecting platform strategy, infrastructure, safety, production capacity, or market adoption at scale.',
    ],
    downrank_signals: [
      'Car reviews, minor model trims, local dealership news, motorsport items, or speculative launch rumors.',
    ],
  },
  'fintech-crypto': {
    p0_signals: [
      'Major payments, banking, stablecoin, exchange, custody, fraud, regulation, market infrastructure, or systemic financial technology shift.',
      'Event with clear consequences for financial institutions, regulators, users, or enterprise adoption.',
    ],
    downrank_signals: [
      'Token price movement alone, influencer commentary, promotional partnerships, minor app features, or speculative trading content.',
    ],
  },
  'crypto-web3': {
    p0_signals: [
      'Major protocol, wallet, exchange, stablecoin, regulation, exploit, custody, scaling, or institutional adoption shift.',
      'Web3 event with broad security, market infrastructure, developer, or regulatory consequences.',
    ],
    downrank_signals: [
      'NFT drops, memecoin movement, promotional ecosystem updates, or price-only coverage without technology or regulatory signal.',
    ],
  },
};

function impactGuidanceOverrides() {
  const raw = process.env.IMPACT_CATEGORY_GUIDANCE_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`Ignoring invalid IMPACT_CATEGORY_GUIDANCE_JSON: ${error.message}`);
    return {};
  }
}

const CATEGORY_IMPACT_GUIDANCE_OVERRIDES = impactGuidanceOverrides();

function categoryLabel(slug = '') {
  return cleanText(slug || 'technology').replaceAll('-', ' ');
}

function mergeGuidance(categorySlug) {
  const overlay = {
    ...(CATEGORY_IMPACT_GUIDANCE[categorySlug] || {}),
    ...(CATEGORY_IMPACT_GUIDANCE_OVERRIDES[categorySlug] || {}),
  };
  return {
    p0_signals: [...DEFAULT_CATEGORY_GUIDANCE.p0_signals, ...(overlay.p0_signals || [])],
    p1_signals: [...DEFAULT_CATEGORY_GUIDANCE.p1_signals, ...(overlay.p1_signals || [])],
    downrank_signals: [...DEFAULT_CATEGORY_GUIDANCE.downrank_signals, ...(overlay.downrank_signals || [])],
  };
}

function guidanceSlugForInputs(inputs) {
  const slugs = [...new Set(inputs.map((input) => input.category).filter(Boolean))];
  if (config.impactCategorySlug) return config.impactCategorySlug;
  return slugs.length === 1 ? slugs[0] : 'all';
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function levelForScore(score) {
  if (score >= 85) return 'P0';
  if (score >= 65) return 'P1';
  if (score >= 40) return 'P2';
  return 'P3';
}

function normalizeLevel(value, score) {
  return ['P0', 'P1', 'P2', 'P3'].includes(value) ? value : levelForScore(score);
}

function normalizeCategory(value) {
  return IMPACT_CATEGORIES.includes(value) ? value : 'noise';
}

function clusterText(cluster) {
  return [
    cluster.title,
    ...(cluster.articles || []).flatMap((article) => [article.title, article.summary]),
  ].map(cleanText).join(' ').toLowerCase();
}

function isPersonalHowToCluster(cluster) {
  if (Number(cluster.article_count || 0) > 1 || Number(cluster.source_count || 0) > 1) return false;
  const text = clusterText(cluster);
  return [
    'how you can',
    'how to',
    'i asked',
    'i tried',
    'painted a picture',
    'visual oracle',
    'my life might look',
  ].some((pattern) => text.includes(pattern));
}

function calibrateScore(cluster, score) {
  let impactScore = normalizeScore(score.impact_score);
  let impactCategory = normalizeCategory(score.impact_category);
  let summary = cleanText(score.summary);
  let whyItMatters = cleanText(score.why_it_matters);
  let reasons = Array.isArray(score.impact_reasons)
    ? score.impact_reasons.map(cleanText).filter(Boolean).slice(0, 6)
    : [];

  if (isPersonalHowToCluster(cluster)) {
    impactScore = Math.min(impactScore, 35);
    impactCategory = 'noise';
    summary = cleanText(cluster.title).slice(0, 300);
    whyItMatters = 'Articulo de uso personal o tutorial sin senal suficiente de impacto ejecutivo amplio.';
    reasons = [
      'Single-source article.',
      'Personal how-to/tutorial framing.',
      'No evidence of platform, policy, security, market, or infrastructure shift.',
    ];
  }

  const evidenceCapped = capImpactForEvidence(cluster, {
    impactScore,
    impactCategory,
    summary,
    whyItMatters,
    reasons,
  });
  impactScore = normalizeScore(evidenceCapped.impactScore);
  impactCategory = normalizeCategory(evidenceCapped.impactCategory);
  summary = evidenceCapped.summary;
  whyItMatters = evidenceCapped.whyItMatters;
  reasons = evidenceCapped.reasons;

  return {
    impactScore,
    impactLevel: levelForScore(impactScore),
    impactCategory,
    summary,
    whyItMatters,
    reasons,
    evidenceConfidence: evidenceCapped.evidenceConfidence,
    evidenceQualityScore: evidenceCapped.evidenceQualityScore,
    evidenceReasons: evidenceCapped.evidenceReasons,
  };
}

function clusterInput(cluster) {
  const articles = (cluster.articles || []).slice(0, 8).map((article, index) => ({
    index: index + 1,
    title: cleanText(article.title).slice(0, 220),
    source: article.source || hostFromUrl(article.url),
    published_at: article.published_at,
    summary: cleanText(article.summary).slice(0, 700),
  }));

  return {
    cluster_id: cluster.id,
    title: cleanText(cluster.title).slice(0, 240),
    category: cluster.category_slug,
    article_count: Number(cluster.article_count || 0),
    source_count: Number(cluster.source_count || 0),
    latest_published_at: cluster.latest_published_at,
    first_published_at: cluster.first_published_at,
    avg_similarity: Number(cluster.avg_similarity || 0),
    min_similarity: Number(cluster.min_similarity || 0),
    articles,
  };
}

function clusterInputHash(cluster) {
  return hashInput(JSON.stringify({
    rubric: RUBRIC_VERSION,
    model_fallbacks: config.impactModelFallbacks,
    cluster: clusterInput(cluster),
  }));
}

function fallbackSpecs() {
  return config.impactModelFallbacks.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) return { provider: 'openai', model: entry };
    return {
      provider: entry.slice(0, separator),
      model: entry.slice(separator + 1),
    };
  }).filter((spec) => spec.provider && spec.model)
    .filter((spec) => llmProviderEnabled({
      provider: spec.provider,
      model: spec.model,
      operation: 'impact_scoring',
    }));
}

function usageFromOpenRouter(body = {}) {
  return usageFromChatCompletion(body);
}

function usageFromNvidia(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromGroq(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromCerebras(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromSambanova(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromMistral(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromLlmRack(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromGithubModels(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromCloudflare(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromGemini(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function usageFromLocal(body = {}) {
  return { ...usageFromChatCompletion(body), costUsd: 0 };
}

function impactJsonSchema() {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cluster_id: { type: 'string' },
            impact_level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            impact_score: { type: 'integer' },
            impact_category: { type: 'string', enum: IMPACT_CATEGORIES },
            summary: { type: 'string' },
            why_it_matters: { type: 'string' },
            impact_reasons: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'cluster_id',
            'impact_level',
            'impact_score',
            'impact_category',
            'summary',
            'why_it_matters',
            'impact_reasons',
          ],
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

function impactMessages(category, inputs) {
  const categorySlug = guidanceSlugForInputs(inputs);
  const categoryGuidance = categorySlug === 'all'
    ? { note: 'Mixed-category batch. Apply the category field inside each cluster and avoid comparing importance across unrelated categories.' }
    : mergeGuidance(categorySlug);

  return [
    {
      role: 'system',
      content: [
        `You score the real-world impact of ${category} news clusters for an executive technology reader.`,
        'Use a composite signal scoring model: independent source coverage, source authority, recency, market/business impact, policy/regulatory impact, security/safety risk, developer impact, infrastructure impact, novelty, and breadth of affected audience.',
        'Use research synthesis: identify the single story in the cluster, explain why it matters, and cite concrete reasons from the provided evidence.',
        'Return only compact valid JSON. Do not include markdown or commentary.',
        'Use this JSON shape: {"results":[{"cluster_id":"...","impact_level":"P0|P1|P2|P3","impact_score":0-100,"impact_category":"breakthrough|business|infrastructure|product|policy|security-risk|developer-impact|societal-impact|research|market|noise","summary":"...","why_it_matters":"...","impact_reasons":["..."]}]}',
        'Score first, then assign the level strictly from score: P0=85-100, P1=65-84, P2=40-64, P3=0-39.',
        'P0 means must read today because it can change decisions, risk, markets, products, platforms, operations, or regulation. P1 means important to monitor today. P2 means useful but not urgent. P3 means low impact/noise/tangential.',
        'Evidence gate: P0 requires concrete evidence in article titles/summaries and either independent corroboration or a clearly authoritative source. Never infer a global event from an ambiguous title alone.',
        'If the evidence is thin, metadata-only, a Hacker News wrapper, or lacks a substantive article summary, down-rank it. Do not invent shutdowns, breaches, bans, market impact, user counts, dates, causality, or named actors not explicitly supported by the evidence.',
        'Do not reward duplicate articles alone. Multi-source coverage matters only when sources add independent evidence.',
        'Down-rank routine releases, minor local items, generic commentary, promotional content, rumors, tutorials, reviews, and price-only market stories unless the evidence shows broad consequence.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        rubric_version: RUBRIC_VERSION,
        category_guidance_slug: categorySlug,
        category_guidance: categoryGuidance,
        scoring_guidance: {
          p0: '85-100. Major model/platform/regulatory/security/business shift with broad consequences.',
          p1: '65-84. Important product, policy, market, infrastructure, or developer-impact story.',
          p2: '40-64. Relevant but niche, incremental, local, or narrow audience.',
          p3: '0-39. Low-impact, promotional, duplicate, weakly substantiated, or tangential.',
        },
        impact_categories: IMPACT_CATEGORIES,
        clusters: inputs,
      }),
    },
  ];
}

async function createOpenRouterImpactScore({ model, category, inputs, clusters }) {
  if (!config.openRouterApiKey) throw new Error('OPENROUTER_API_KEY is required for OpenRouter impact fallback');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(config.openRouterRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.openRouterApiKey}`,
      'content-type': 'application/json',
      ...(config.openRouterReferer ? { 'http-referer': config.openRouterReferer } : {}),
      'x-title': config.openRouterTitle,
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      reasoning: model.includes('nemotron-3-super') ? { enabled: false } : undefined,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('OpenRouter response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromOpenRouter(body),
    rawModelResponse: content,
    clusters,
  };
}

function localLlmBaseUrl(provider) {
  return provider === 'local-intel' ? config.localIntelLlmBaseUrl : config.localLlmBaseUrl;
}

function localLlmRequestTimeoutMs(provider) {
  return provider === 'local-intel' ? config.localIntelLlmRequestTimeoutMs : config.localLlmRequestTimeoutMs;
}

async function createLocalImpactScore({ provider = 'local', model, category, inputs, clusters }) {
  const maxAttempts = Math.max(1, Number(config.llmLocalRetryAttempts) || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${localLlmBaseUrl(provider).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(localLlmRequestTimeoutMs(provider)),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: impactMessages(category, inputs),
          temperature: 0.1,
          max_tokens: config.impactMaxOutputTokens,
          response_format: { type: 'json_object' },
          stream: false,
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`${provider} ${response.status}: ${raw.slice(0, 700)}`);
      }

      const body = JSON.parse(raw);
      const content = body.choices?.[0]?.message?.content || '';
      const parsed = parseJsonObject(content);
      if (!Array.isArray(parsed.results)) throw new Error(`${provider} response missing results array`);
      return {
        parsed,
        resolvedModel: body.model || model,
        usage: usageFromLocal(body),
        rawModelResponse: content,
        clusters,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, config.llmLocalRetryDelayMs));
      }
    }
  }

  throw lastError;
}

async function createNvidiaImpactScore({ model, category, inputs, clusters }) {
  if (!config.nvidiaApiKey) throw new Error('NVIDIA_API_KEY is required for NVIDIA impact fallback');
  const response = await fetch(`${config.nvidiaBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.nvidiaRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.nvidiaApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'cluster_impact_scores',
          schema: impactJsonSchema(),
        },
      },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`NVIDIA ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('NVIDIA response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromNvidia(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createGroqImpactScore({ model, category, inputs, clusters }) {
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY is required for Groq impact fallback');
  const response = await fetch(`${config.groqBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.groqRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.groqApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Groq ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('Groq response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromGroq(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createCerebrasImpactScore({ model, category, inputs, clusters }) {
  if (!config.cerebrasApiKey) throw new Error('CEREBRAS_API_KEY is required for Cerebras impact fallback');
  const response = await fetch(`${config.cerebrasBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.cerebrasRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.cerebrasApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Cerebras ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('Cerebras response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromCerebras(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createSambanovaImpactScore({ model, category, inputs, clusters }) {
  if (!config.sambanovaApiKey) throw new Error('SAMBANOVA_API_KEY is required for SambaNova impact fallback');
  const response = await fetch(`${config.sambanovaBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.sambanovaRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.sambanovaApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`SambaNova ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('SambaNova response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromSambanova(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createMistralImpactScore({ model, category, inputs, clusters }) {
  if (!config.mistralApiKey) throw new Error('MISTRAL_API_KEY is required for Mistral impact fallback');
  const response = await fetch(`${config.mistralBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.mistralRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.mistralApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Mistral ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('Mistral response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromMistral(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createLlmRackImpactScore({ model, category, inputs, clusters }) {
  if (!config.llmRackApiKey) throw new Error('LLMRACK_API_KEY is required for LLMRack impact fallback');
  const response = await fetch(`${config.llmRackBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.llmRackRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.llmRackApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLMRack ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('LLMRack response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromLlmRack(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createGithubImpactScore({ model, category, inputs, clusters }) {
  if (!config.githubModelsToken) throw new Error('GITHUB_MODELS_TOKEN is required for GitHub Models impact fallback');
  const response = await fetch(`${config.githubModelsBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.githubModelsRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.githubModelsToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub Models ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('GitHub Models response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromGithubModels(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createCloudflareImpactScore({ model, category, inputs, clusters }) {
  if (!config.cloudflareApiToken) throw new Error('CLOUDFLARE_API_TOKEN is required for Cloudflare impact fallback');
  if (!config.cloudflareAccountId && !config.cloudflareBaseUrl) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BASE_URL is required for Cloudflare impact fallback');
  }
  const baseUrl = config.cloudflareBaseUrl
    || `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/v1`;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.cloudflareRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${config.cloudflareApiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: impactMessages(category, inputs),
      temperature: 0.1,
      max_tokens: config.impactMaxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'cluster_impact_scores',
          schema: impactJsonSchema(),
        },
      },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Cloudflare ${response.status}: ${raw.slice(0, 700)}`);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('Cloudflare response missing results array');
  return {
    parsed,
    resolvedModel: body.model || model,
    usage: usageFromCloudflare(body),
    rawModelResponse: content,
    clusters,
  };
}

async function createGeminiImpactScore({ model, category, inputs, clusters }) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is required for Gemini impact fallback');
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
          parts: [{ text: geminiPromptFromMessages(impactMessages(category, inputs)) }],
        }],
        generationConfig: geminiGenerationConfig({
          model,
          maxOutputTokens: config.impactMaxOutputTokens,
          responseJsonSchema: impactJsonSchema(),
        }),
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${raw.slice(0, 700)}`);
  }

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
    rawModelResponse: content,
    clusters,
  };
}

async function createOpenAIImpactScore({ openai, model, category, inputs }) {
  if (!openai) throw new Error('OPENAI_API_KEY is required for OpenAI impact fallback');
  const response = await openai.responses.create({
    model,
    input: impactMessages(category, inputs),
    text: {
      format: {
        type: 'json_schema',
        name: 'cluster_impact_scores',
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
                required: [
                  'cluster_id',
                  'impact_level',
                  'impact_score',
                  'impact_category',
                  'summary',
                  'why_it_matters',
                  'impact_reasons',
                ],
                properties: {
                  cluster_id: { type: 'string' },
                  impact_level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
                  impact_score: { type: 'integer' },
                  impact_category: { type: 'string', enum: IMPACT_CATEGORIES },
                  summary: { type: 'string' },
                  why_it_matters: { type: 'string' },
                  impact_reasons: {
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

  return {
    parsed: JSON.parse(responseText(response)),
    resolvedModel: response.model || model,
    usage: usageFromOpenAIResponse(response),
  };
}

async function cleanupStaleImpactRuns() {
  await pool.query(
    `UPDATE impact_scoring_runs
     SET status = 'interrupted',
         finished_at = NOW(),
         error = 'Worker stopped before completing this run'
     WHERE status = 'running'
       AND started_at < NOW() - ($1::int * INTERVAL '1 minute')`,
    [config.impactRunStaleMinutes],
  );
}

export async function enqueueImpactJobs() {
  const params = [
    config.embeddingModel,
    config.impactWindowHours,
    JSON.stringify(config.impactWindowHoursByCategory || {}),
    JSON.stringify(config.impactMaxClusterAgeHoursByCategory || {}),
    config.impactMaxClusterAgeHours,
  ];
  let categoryFilter = '';
  let minPublishedAtFilter = '';

  if (config.impactMinPublishedAt) {
    params.push(config.impactMinPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  if (config.impactCategorySlug) {
    params.push(config.impactCategorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  await pool.query(`
    DELETE FROM cluster_impact_jobs j
    USING story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    WHERE sc.id = j.cluster_id
      AND (
        ($1::timestamptz IS NOT NULL AND sc.latest_published_at < $1::timestamptz)
        OR sc.latest_published_at < NOW() - (${impactWindowHoursExpression('tc')} * INTERVAL '1 hour')
        OR (${impactMaxClusterAgeExpression('tc')} > 0
          AND sc.created_at < NOW() - (${impactMaxClusterAgeExpression('tc')} * INTERVAL '1 hour'))
      )
  `, [
    config.impactMinPublishedAt || null,
    config.impactWindowHours,
    JSON.stringify(config.impactWindowHoursByCategory || {}),
    JSON.stringify(config.impactMaxClusterAgeHoursByCategory || {}),
    config.impactMaxClusterAgeHours,
  ]);

  try {
    await pool.query(`
      INSERT INTO cluster_impact_jobs (cluster_id, status)
      SELECT sc.id, 'pending'
      FROM story_clusters sc
      JOIN topic_categories tc ON tc.id = sc.category_id
      LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE sc.embedding_model = $1
        ${impactEligibilitySql()}
        ${minPublishedAtFilter}
        AND (
          cis.cluster_id IS NULL
          OR cis.scored_at < sc.updated_at
        )
        ${categoryFilter}
      ON CONFLICT (cluster_id) DO NOTHING
    `, params);
  } catch (error) {
    if (error.code !== '23503') {
      throw error;
    }
    console.warn('Skipped enqueueImpactJobs cycle because a cluster was deleted concurrently');
  }

  await pool.query(`
    UPDATE cluster_impact_jobs
    SET status = 'pending',
        locked_by = NULL,
        locked_at = NULL,
        updated_at = NOW()
    WHERE status = 'running'
      AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')
  `, [config.impactJobStaleMinutes]);

  await pool.query(`
    UPDATE cluster_impact_jobs
    SET status = 'pending',
        locked_by = NULL,
        locked_at = NULL,
        updated_at = NOW()
    WHERE status = 'failed'
      AND attempts < $1
      AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')
  `, [config.impactJobMaxAttempts, config.impactJobRetryMinutes]);

  await pool.query(`
    UPDATE cluster_impact_jobs
    SET status = 'pending',
        attempts = 0,
        locked_by = NULL,
        locked_at = NULL,
        updated_at = NOW()
    WHERE status = 'failed'
      AND attempts >= $1
      AND last_error LIKE 'All impact scoring fallbacks failed:%'
      AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')
  `, [config.impactJobMaxAttempts, config.impactJobRetryMinutes]);

  await pool.query(`
    UPDATE cluster_impact_jobs j
    SET status = 'pending',
        locked_by = NULL,
        locked_at = NULL,
        updated_at = NOW(),
        completed_at = NULL
    FROM story_clusters sc
    LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      JOIN topic_categories tc ON tc.id = sc.category_id
      WHERE j.cluster_id = sc.id
        AND j.status = 'done'
        AND sc.embedding_model = $1
      ${impactEligibilitySql()}
      ${minPublishedAtFilter}
      AND (
        cis.cluster_id IS NULL
        OR cis.scored_at < sc.updated_at
        OR j.completed_at < sc.updated_at
      )
      ${categoryFilter}
  `, params);
}

async function claimImpactJobIds() {
  const params = [
    config.embeddingModel,
    config.impactWindowHours,
    JSON.stringify(config.impactWindowHoursByCategory || {}),
    JSON.stringify(config.impactMaxClusterAgeHoursByCategory || {}),
    config.impactMaxClusterAgeHours,
  ];
  let categoryFilter = '';
  let minPublishedAtFilter = '';

  if (config.impactMinPublishedAt) {
    params.push(config.impactMinPublishedAt);
    minPublishedAtFilter = `AND sc.latest_published_at >= $${params.length}::timestamptz`;
  }

  if (config.impactCategorySlug) {
    params.push(config.impactCategorySlug);
    categoryFilter = `AND tc.slug = $${params.length}`;
  }

  params.push(config.impactBatchSize);
  const batchSizeParam = `$${params.length}`;
  params.push(WORKER_ID);
  const workerParam = `$${params.length}`;

  const { rows } = await pool.query(`
    WITH ranked_jobs AS (
      SELECT
        j.cluster_id,
        row_number() OVER (
          PARTITION BY sc.category_id
          ORDER BY
            cis.cluster_id IS NOT NULL ASC,
            sc.latest_published_at DESC NULLS LAST,
            j.updated_at ASC,
            j.cluster_id
        ) AS category_rank,
        sc.latest_published_at,
        j.updated_at
      FROM cluster_impact_jobs j
      JOIN story_clusters sc ON sc.id = j.cluster_id
      JOIN topic_categories tc ON tc.id = sc.category_id
      LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE j.status = 'pending'
        AND sc.embedding_model = $1
        ${impactEligibilitySql()}
        ${minPublishedAtFilter}
        ${categoryFilter}
    ),
    next_jobs AS (
      SELECT j.cluster_id
      FROM cluster_impact_jobs j
      JOIN ranked_jobs r ON r.cluster_id = j.cluster_id
      WHERE j.status = 'pending'
      ORDER BY
        r.category_rank ASC,
        r.latest_published_at DESC NULLS LAST,
        r.updated_at ASC,
        j.cluster_id
      LIMIT ${batchSizeParam}
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE cluster_impact_jobs j
    SET status = 'running',
        locked_by = ${workerParam},
        locked_at = NOW(),
        attempts = attempts + 1,
        updated_at = NOW()
    FROM next_jobs
    WHERE j.cluster_id = next_jobs.cluster_id
    RETURNING j.cluster_id
  `, params);

  return rows.map((row) => row.cluster_id);
}

async function markImpactJobsDone(clusterIds) {
  if (clusterIds.length === 0) return;
  await pool.query(
    `UPDATE cluster_impact_jobs
     SET status = 'done',
         locked_by = NULL,
         locked_at = NULL,
         last_error = NULL,
         updated_at = NOW(),
         completed_at = NOW()
     WHERE cluster_id = ANY($1::uuid[])`,
    [clusterIds],
  );
}

function isRetryableCooldownFailure(error) {
  const message = cleanText(error);
  if (!message.startsWith('All impact scoring fallbacks failed:')) return false;

  const fallbackErrors = message
    .replace('All impact scoring fallbacks failed:', '')
    .split(' | ')
    .map((item) => item.trim())
    .filter(Boolean);

  if (fallbackErrors.length === 0) return false;

  const retryableCooldownReasons = [
    'cooldown rpm_spacing',
    'cooldown daily_budget_guard',
    'cooldown daily_rate_limit',
  ];

  return fallbackErrors.some((item) => item.includes('cooldown rpm_spacing'))
    && fallbackErrors.every((item) => retryableCooldownReasons.some((reason) => item.includes(reason)));
}

async function markImpactJobsFailed(clusterIds, error) {
  if (clusterIds.length === 0) return;
  const cleanedError = cleanText(error).slice(0, 1000);
  const retryableCooldown = isRetryableCooldownFailure(error);
  await pool.query(
    `UPDATE cluster_impact_jobs
     SET status = CASE
           WHEN $4::boolean THEN 'pending'
           WHEN attempts >= $2 THEN 'failed'
           ELSE 'pending'
         END,
         attempts = CASE WHEN $4::boolean THEN 0 ELSE attempts END,
         locked_by = NULL,
         locked_at = NULL,
         last_error = $3,
         updated_at = NOW()
     WHERE cluster_id = ANY($1::uuid[])`,
    [clusterIds, config.impactJobMaxAttempts, cleanedError, retryableCooldown],
  );
}

async function loadCandidateClusters() {
  await enqueueImpactJobs();
  const clusterIds = await claimImpactJobIds();
  if (clusterIds.length === 0) return [];

  const { rows } = await pool.query(`
    WITH cluster_items AS (
      SELECT
        sc.id,
        sc.title,
        sc.summary,
        sc.article_count,
        sc.first_published_at,
        sc.latest_published_at,
        tc.slug AS category_slug,
        tc.name AS category_name,
        cis.input_hash AS existing_input_hash,
        avg(ca.similarity)::float AS avg_similarity,
        min(ca.similarity)::float AS min_similarity,
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
      JOIN cluster_articles ca ON ca.cluster_id = sc.id
      JOIN articles a ON a.id = ca.article_id
      LEFT JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
      WHERE sc.id = ANY($1::uuid[])
      GROUP BY sc.id, tc.slug, tc.name, cis.input_hash
    )
    SELECT *
    FROM cluster_items
    ORDER BY latest_published_at DESC NULLS LAST, id DESC
  `, [clusterIds]);

  const clusters = rows
    .map((cluster) => ({
      ...cluster,
      computed_input_hash: clusterInputHash(cluster),
    }));
  const alreadyCurrent = clusters
    .filter((cluster) => cluster.existing_input_hash === cluster.computed_input_hash)
    .map((cluster) => cluster.id);
  await markImpactJobsDone(alreadyCurrent);

  const loadableIds = new Set(clusters.map((cluster) => cluster.id));
  const missingIds = clusterIds.filter((clusterId) => !loadableIds.has(clusterId));
  await markImpactJobsFailed(missingIds, 'Claimed impact job could not be loaded');

  return clusters.filter((cluster) => cluster.existing_input_hash !== cluster.computed_input_hash);
}

async function scoreClusters(openai, clusters) {
  if (clusters.length === 0) return [];

  const category = categoryLabel(config.impactCategorySlug || clusters[0]?.category_slug);
  const inputs = clusters.map(clusterInput);
  console.log(`Impact scoring request: category=${config.impactCategorySlug || 'all'} clusters=${clusters.length}`);

  let parsed = null;
  let winner = null;
  const errors = [];

  for (const spec of fallbackSpecs()) {
    const started = Date.now();
    const operation = 'impact_scoring';
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

    const generation = spec.provider === 'openai' ? null : startLangfuseGeneration(`signalrss-${config.impactCategorySlug || 'all'}-impact-scorer`, {
      input: {
        category,
        clusterCount: clusters.length,
        clusterIds: clusters.map((cluster) => cluster.id),
      },
      model: spec.model,
      modelParameters: {
        provider: spec.provider,
        temperature: 0.1,
        max_tokens: config.impactMaxOutputTokens,
      },
      metadata: {
        app: 'SignalRSS',
        component: `${config.impactCategorySlug || 'all'}-impact-scorer`,
        operation: 'impact_scoring',
        categorySlug: config.impactCategorySlug || clusters[0]?.category_slug || null,
        worker_id: WORKER_ID,
      },
    });
    try {
      let result;
      if (spec.provider === 'local' || spec.provider === 'local-intel') {
        result = await createLocalImpactScore({ provider: spec.provider, model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'nvidia') {
        result = await createNvidiaImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'groq') {
        result = await createGroqImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'cerebras') {
        result = await createCerebrasImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'sambanova') {
        result = await createSambanovaImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'mistral') {
        result = await createMistralImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'llmrack') {
        result = await createLlmRackImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'cloudflare') {
        result = await createCloudflareImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'github') {
        result = await createGithubImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'gemini') {
        result = await createGeminiImpactScore({ model: spec.model, category, inputs, clusters });
      } else if (spec.provider === 'openrouter') {
        result = await createOpenRouterImpactScore({ model: spec.model, category, inputs, clusters });
      } else {
        result = await createOpenAIImpactScore({ openai, model: spec.model, category, inputs });
      }

      await logLlmRequest({
        operation,
        provider: spec.provider,
        requestedModel: spec.model,
        resolvedModel: result.resolvedModel,
        status: 'ok',
        categorySlug: config.impactCategorySlug || clusters[0]?.category_slug || null,
        batchSize: clusters.length,
        usage: result.usage,
        latencyMs: Date.now() - started,
        metadata: { worker_id: WORKER_ID },
      });
      await recordLlmSuccess({ provider: spec.provider, model: spec.model, operation });

      generation?.update({
        output: {
          resultCount: result.parsed?.results?.length || 0,
          resolvedModel: result.resolvedModel,
        },
        usageDetails: {
          input: result.usage?.promptTokens || 0,
          output: result.usage?.completionTokens || 0,
          total: result.usage?.totalTokens || 0,
        },
        metadata: {
          costUsd: result.usage?.costUsd ?? null,
        },
      });
      generation?.end();

      parsed = result.parsed;
      winner = {
        provider: spec.provider,
        requestedModel: spec.model,
        resolvedModel: result.resolvedModel,
      };
      break;
    } catch (error) {
      generation?.update({
        level: 'ERROR',
        statusMessage: error.message,
        output: { error: error.message },
      });
      generation?.end();
      errors.push(`${spec.provider}:${spec.model}: ${error.message}`);
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
        categorySlug: config.impactCategorySlug || clusters[0]?.category_slug || null,
        batchSize: clusters.length,
        latencyMs: Date.now() - started,
        error: error.message,
        metadata: { worker_id: WORKER_ID },
      });
      console.warn(`Impact scoring fallback failed provider=${spec.provider} model=${spec.model}: ${error.message}`);
    }
  }

  if (!parsed || !winner) {
    throw new Error(`All impact scoring fallbacks failed: ${errors.join(' | ')}`);
  }

  console.log(`Impact scoring response: category=${config.impactCategorySlug || 'all'} clusters=${clusters.length} provider=${winner.provider} model=${winner.resolvedModel || winner.requestedModel}`);
  const expectedIds = new Set(clusters.map((cluster) => cluster.id));
  const uniqueResults = new Map();
  for (const result of parsed.results || []) {
    if (expectedIds.has(result.cluster_id) && !uniqueResults.has(result.cluster_id)) {
      uniqueResults.set(result.cluster_id, {
        ...result,
        model: winner.resolvedModel || winner.requestedModel,
        provider: winner.provider,
      });
    }
  }
  return [...uniqueResults.values()];
}

async function saveScores(clusters, scores) {
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  let saved = 0;

  for (const score of scores) {
    const cluster = clustersById.get(score.cluster_id);
    if (!cluster) continue;

    const calibrated = calibrateScore(cluster, score);

    const result = await pool.query(
      `INSERT INTO cluster_impact_scores (
         cluster_id,
         impact_level,
         impact_score,
         impact_category,
         summary,
         why_it_matters,
         impact_reasons,
         evidence_confidence,
         evidence_quality_score,
         evidence_reasons,
         model,
         input_hash,
         scored_at,
         updated_at
       )
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, NOW(), NOW()
       WHERE EXISTS (
         SELECT 1
         FROM story_clusters
         WHERE id = $1
       )
       ON CONFLICT (cluster_id) DO UPDATE SET
         impact_level = EXCLUDED.impact_level,
         impact_score = EXCLUDED.impact_score,
         impact_category = EXCLUDED.impact_category,
         summary = EXCLUDED.summary,
         why_it_matters = EXCLUDED.why_it_matters,
         impact_reasons = EXCLUDED.impact_reasons,
         evidence_confidence = EXCLUDED.evidence_confidence,
         evidence_quality_score = EXCLUDED.evidence_quality_score,
         evidence_reasons = EXCLUDED.evidence_reasons,
         model = EXCLUDED.model,
         input_hash = EXCLUDED.input_hash,
         scored_at = NOW(),
         updated_at = NOW()`,
      [
        cluster.id,
        calibrated.impactLevel,
        calibrated.impactScore,
        calibrated.impactCategory,
        calibrated.summary.slice(0, 700),
        calibrated.whyItMatters.slice(0, 900),
        JSON.stringify(calibrated.reasons),
        calibrated.evidenceConfidence,
        calibrated.evidenceQualityScore,
        JSON.stringify(calibrated.evidenceReasons),
        score.model || config.impactModel,
        cluster.computed_input_hash,
      ],
    );
    saved += result.rowCount;
    if (result.rowCount > 0 && isBriefingExcluded(cluster.category_slug, calibrated.impactLevel)) {
      await pool.query('DELETE FROM story_clusters WHERE id = $1', [cluster.id]);
      console.log(`Deleted excluded briefing cluster category=${cluster.category_slug} level=${calibrated.impactLevel} cluster=${cluster.id}`);
    }
  }

  return saved;
}

async function scoreClustersWithOmittedRetries(openai, clusters) {
  const initialScores = await scoreClusters(openai, clusters);
  const scoresByClusterId = new Map(initialScores.map((score) => [score.cluster_id, score]));
  const retryErrors = new Map();

  const omittedClusters = clusters.filter((cluster) => !scoresByClusterId.has(cluster.id));
  if (omittedClusters.length > 0) {
    console.warn(`Impact scoring response omitted ${omittedClusters.length}/${clusters.length} clusters; retrying individually`);
  }

  for (const cluster of omittedClusters) {
    try {
      const retryScores = await scoreClusters(openai, [cluster]);
      const retryScore = retryScores.find((score) => score.cluster_id === cluster.id);
      if (retryScore) {
        scoresByClusterId.set(cluster.id, retryScore);
      } else {
        retryErrors.set(cluster.id, 'Impact response omitted this cluster after individual retry');
      }
    } catch (error) {
      retryErrors.set(cluster.id, error.message);
    }
  }

  return {
    scores: [...scoresByClusterId.values()],
    retryErrors,
  };
}

export async function runImpactScoring({
  closeConnections = true,
  runUntilEmpty = config.impactRunUntilEmpty,
  maxBatches = 1,
} = {}) {
  const fallbackProviders = new Set(fallbackSpecs().map((spec) => spec.provider));
  if (fallbackProviders.has('openai') && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required because IMPACT_MODEL_FALLBACKS includes openai');
  }
  if (fallbackProviders.has('openrouter') && !config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required because IMPACT_MODEL_FALLBACKS includes openrouter');
  }
  if (fallbackProviders.has('nvidia') && !config.nvidiaApiKey) {
    throw new Error('NVIDIA_API_KEY is required because IMPACT_MODEL_FALLBACKS includes nvidia');
  }
  if (fallbackProviders.has('groq') && !config.groqApiKey) {
    throw new Error('GROQ_API_KEY is required because IMPACT_MODEL_FALLBACKS includes groq');
  }
  if (fallbackProviders.has('cerebras') && !config.cerebrasApiKey) {
    throw new Error('CEREBRAS_API_KEY is required because IMPACT_MODEL_FALLBACKS includes cerebras');
  }
  if (fallbackProviders.has('sambanova') && !config.sambanovaApiKey) {
    throw new Error('SAMBANOVA_API_KEY is required because IMPACT_MODEL_FALLBACKS includes sambanova');
  }
  if (fallbackProviders.has('mistral') && !config.mistralApiKey) {
    throw new Error('MISTRAL_API_KEY is required because IMPACT_MODEL_FALLBACKS includes mistral');
  }
  if (fallbackProviders.has('llmrack') && !config.llmRackApiKey) {
    throw new Error('LLMRACK_API_KEY is required because IMPACT_MODEL_FALLBACKS includes llmrack');
  }
  if (fallbackProviders.has('github') && !config.githubModelsToken) {
    throw new Error('GITHUB_MODELS_TOKEN is required because IMPACT_MODEL_FALLBACKS includes github');
  }
  if (fallbackProviders.has('cloudflare') && !config.cloudflareApiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is required because IMPACT_MODEL_FALLBACKS includes cloudflare');
  }
  if (fallbackProviders.has('gemini') && !config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required because IMPACT_MODEL_FALLBACKS includes gemini');
  }

  const traceCategory = config.impactCategorySlug || 'all-categories';
  let tracing = null;
  let openai = null;
  let runId = null;

  async function ensureScorer() {
    if (openai) return openai;
    if (!fallbackProviders.has('openai')) return null;

    tracing = startLangfuseTracing();
    openai = observeOpenAIClient(new OpenAI({ apiKey: config.openaiApiKey }), {
      impactModel: config.impactModel,
      impactBatchSize: config.impactBatchSize,
      impactCategorySlug: config.impactCategorySlug,
      impactWindowHours: config.impactWindowHours,
    }, {
      traceName: `signalrss-${traceCategory}-impact-scorer`,
      component: `${traceCategory}-impact-scorer`,
    });

    const run = await pool.query(
      `INSERT INTO impact_scoring_runs (status, model, category_slug)
       VALUES ('running', $1, $2)
       RETURNING id`,
      [config.impactModel, config.impactCategorySlug || null],
    );
    runId = run.rows[0].id;
    return openai;
  }

  let clusters = [];

  try {
    await cleanupStaleImpactRuns();
    let considered = 0;
    let scored = 0;
    let batch = 0;
    const batchLimit = runUntilEmpty
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Number(maxBatches) || 1);

    do {
      batch += 1;
      clusters = await loadCandidateClusters();
      if (clusters.length === 0) {
        console.log(`Impact batch ${batch}: scored 0/0`);
        break;
      }

      const { scores, retryErrors } = await scoreClustersWithOmittedRetries(await ensureScorer(), clusters);
      const saved = await saveScores(clusters, scores);
      const scoredIds = scores.map((score) => score.cluster_id);
      const scoredSet = new Set(scoredIds);
      await markImpactJobsDone(scoredIds);
      const omittedClusters = clusters.filter((cluster) => !scoredSet.has(cluster.id));
      for (const cluster of omittedClusters) {
        await markImpactJobsFailed(
          [cluster.id],
          retryErrors.get(cluster.id) || 'Impact response omitted this cluster',
        );
      }
      considered += clusters.length;
      scored += saved;
      console.log(`Impact batch ${batch}: scored ${saved}/${clusters.length}`);
    } while (batch < batchLimit);

    if (runId) {
      await pool.query(
        `UPDATE impact_scoring_runs
         SET status = 'ok',
             finished_at = NOW(),
             clusters_considered = $2,
             clusters_scored = $3
         WHERE id = $1`,
        [runId, considered, scored],
      );
    }

    console.log(`Impact scored ${scored}/${considered} clusters with fallbacks ${config.impactModelFallbacks.join(',')}`);
    console.log(`Langfuse tracing ${tracing?.enabled ? 'enabled' : 'not started'}`);
  } catch (error) {
    await markImpactJobsFailed(clusters.map((cluster) => cluster.id), error.message);
    if (runId) {
      await pool.query(
        `UPDATE impact_scoring_runs
         SET status = 'failed',
             finished_at = NOW(),
             error = $2
         WHERE id = $1`,
        [runId, error.message],
      );
    }
    throw error;
  } finally {
    if (tracing) await shutdownLangfuseTracing().catch(() => {});
    if (closeConnections) await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runImpactScoring().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
