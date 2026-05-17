import { config } from './config.js';

const DEFAULT_POLICIES = [
  {
    provider: 'mistral',
    model: 'mistral-small-latest',
    rpm: () => config.llmMistralRpm,
    impactMaxBatchSize: null,
    briefingMaxBatchSize: null,
  },
  {
    provider: 'nvidia',
    model: 'openai/gpt-oss-120b',
    rpm: 30,
    tpm: 8000,
    tpd: 200000,
    impactMaxBatchSize: null,
    briefingMaxBatchSize: null,
  },
  {
    provider: 'github',
    model: 'openai/gpt-4.1-mini',
    rpm: () => config.llmGithubLowRpm,
    impactMaxBatchSize: () => config.llmGithubImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmGithubBriefingMaxBatchSize,
  },
  {
    provider: 'github',
    model: 'openai/gpt-4o-mini',
    rpm: () => config.llmGithubLowRpm,
    impactMaxBatchSize: () => config.llmGithubImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmGithubBriefingMaxBatchSize,
  },
  {
    provider: 'github',
    model: 'mistral-ai/mistral-small-2503',
    rpm: () => config.llmGithubLowRpm,
    impactMaxBatchSize: () => config.llmGithubImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmGithubBriefingMaxBatchSize,
  },
  {
    provider: 'github',
    model: 'meta/meta-llama-3.1-8b-instruct',
    rpm: () => config.llmGithubLowRpm,
    impactMaxBatchSize: () => config.llmGithubImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmGithubBriefingMaxBatchSize,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    rpm: 30,
    tpm: 8000,
    tpd: 200000,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    rpm: 30,
    tpm: 8000,
    tpd: 200000,
  },
  {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    rpm: 30,
    tpm: 12000,
    tpd: 100000,
  },
  {
    provider: 'openrouter',
    model: 'openai/gpt-oss-120b:free',
    rpm: () => config.llmOpenRouterFreeRpm,
    rpd: () => config.llmOpenRouterFreeRpd,
    impactMaxBatchSize: () => config.llmOpenRouterImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmOpenRouterBriefingMaxBatchSize,
  },
  {
    provider: 'openrouter',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    rpm: () => config.llmOpenRouterFreeRpm,
    rpd: () => config.llmOpenRouterFreeRpd,
    impactMaxBatchSize: () => config.llmOpenRouterImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmOpenRouterBriefingMaxBatchSize,
  },
  {
    provider: 'sambanova',
    model: 'gpt-oss-120b',
    rpm: () => config.llmSambanovaFreeRpm,
    tpd: 200000,
    impactEnabled: true,
    // Current logs show >95% briefing failures for this model.
    briefingEnabled: false,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rpm: () => config.llmGeminiRpm,
  },
  {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    rpm: () => config.llmGeminiRpm,
    // Current logs show quota/internal-error instability for briefings.
    briefingEnabled: false,
  },
  {
    provider: 'gemini',
    model: 'gemma-4-31b-it',
    rpm: () => config.llmGeminiRpm,
  },
  {
    provider: 'cloudflare',
    model: '@cf/openai/gpt-oss-120b',
    rpm: 10,
  },
  {
    provider: 'cerebras',
    model: 'llama3.1-8b',
    rpm: 30,
  },
  {
    provider: 'llmrack',
    model: 'qwen-2.5-7b',
    rpm: () => config.llmRackRpm,
    tpd: () => config.llmRackTokensPerDay,
    impactMaxBatchSize: () => config.llmRackImpactMaxBatchSize,
    briefingMaxBatchSize: () => config.llmRackBriefingMaxBatchSize,
  },
];

function valueOf(value) {
  return typeof value === 'function' ? value() : value;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function envPolicyKey({ provider, model }) {
  return `LLM_MODEL_POLICY_${String(provider || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${String(model || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  return fallback;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function overridesFor({ provider, model }) {
  const raw = process.env[envPolicyKey({ provider, model })];
  if (!raw) return {};

  const entries = Object.fromEntries(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator < 1) return [part, 'true'];
        return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
      }),
  );

  return {
    enabled: parseBoolean(entries.enabled, undefined),
    impactEnabled: parseBoolean(entries.impact_enabled ?? entries.impactEnabled, undefined),
    briefingEnabled: parseBoolean(entries.briefing_enabled ?? entries.briefingEnabled, undefined),
    rpm: parseNumber(entries.rpm, undefined),
    tpm: parseNumber(entries.tpm, undefined),
    tpd: parseNumber(entries.tpd, undefined),
    rpd: parseNumber(entries.rpd, undefined),
    impactMaxBatchSize: parseNumber(entries.impact_max_batch_size ?? entries.impactMaxBatchSize, undefined),
    briefingMaxBatchSize: parseNumber(entries.briefing_max_batch_size ?? entries.briefingMaxBatchSize, undefined),
  };
}

export function llmModelPolicy({ provider, model }) {
  const base = DEFAULT_POLICIES.find((policy) => (
    normalize(policy.provider) === normalize(provider)
    && normalize(policy.model) === normalize(model)
  )) || { provider, model };
  const overrides = overridesFor({ provider, model });

  const enabled = overrides.enabled ?? valueOf(base.enabled) ?? true;
  const impactEnabled = overrides.impactEnabled ?? valueOf(base.impactEnabled) ?? enabled;
  const briefingEnabled = overrides.briefingEnabled ?? valueOf(base.briefingEnabled) ?? enabled;

  return {
    provider,
    model,
    enabled,
    impactEnabled,
    briefingEnabled,
    rpm: overrides.rpm ?? valueOf(base.rpm) ?? null,
    tpm: overrides.tpm ?? valueOf(base.tpm) ?? null,
    tpd: overrides.tpd ?? valueOf(base.tpd) ?? null,
    rpd: overrides.rpd ?? valueOf(base.rpd) ?? null,
    impactMaxBatchSize: overrides.impactMaxBatchSize ?? valueOf(base.impactMaxBatchSize) ?? null,
    briefingMaxBatchSize: overrides.briefingMaxBatchSize ?? valueOf(base.briefingMaxBatchSize) ?? null,
  };
}

function fallbackSpecs(entries = []) {
  return entries.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) return { provider: 'openai', model: entry };
    return {
      provider: entry.slice(0, separator),
      model: entry.slice(separator + 1),
    };
  }).filter((spec) => spec.provider && spec.model);
}

export function configuredLlmModelPolicies(operation) {
  const fallbacks = operation === 'briefing_generation'
    ? config.briefingModelFallbacks
    : config.impactModelFallbacks;

  return fallbackSpecs(fallbacks).map((spec, index) => {
    const policy = llmModelPolicy(spec);
    return {
      index,
      operation,
      provider: spec.provider,
      model: spec.model,
      enabled: llmProviderEnabled({ ...spec, operation }),
      policy,
    };
  });
}

export function llmProviderEnabled({ provider, model, operation }) {
  const policy = llmModelPolicy({ provider, model });
  if (!policy.enabled) return false;
  if (operation === 'impact_scoring') return policy.impactEnabled;
  if (operation === 'briefing_generation') return policy.briefingEnabled;
  return true;
}

export function llmKnownLimit({ provider, model }) {
  const policy = llmModelPolicy({ provider, model });
  if (!policy.rpm && !policy.tpm && !policy.tpd && !policy.rpd) return null;
  return {
    rpm: policy.rpm,
    tpm: policy.tpm,
    tpd: policy.tpd,
    rpd: policy.rpd,
  };
}

export function maxBatchSizeForLlmProvider({ provider, model, operation }) {
  const policy = llmModelPolicy({ provider, model });
  if (operation === 'briefing_generation' && policy.briefingMaxBatchSize) {
    return policy.briefingMaxBatchSize;
  }
  if (operation === 'impact_scoring' && policy.impactMaxBatchSize) {
    return policy.impactMaxBatchSize;
  }

  if (provider === 'github') {
    return operation === 'briefing_generation'
      ? config.llmGithubBriefingMaxBatchSize
      : config.llmGithubImpactMaxBatchSize;
  }

  if (provider === 'openrouter' && String(model || '').endsWith(':free')) {
    return operation === 'briefing_generation'
      ? config.llmOpenRouterBriefingMaxBatchSize
      : config.llmOpenRouterImpactMaxBatchSize;
  }

  if (provider === 'llmrack') {
    return operation === 'briefing_generation'
      ? config.llmRackBriefingMaxBatchSize
      : config.llmRackImpactMaxBatchSize;
  }

  return null;
}

export function providerCanHandleBatch({ provider, model, operation, batchSize }) {
  if (!llmProviderEnabled({ provider, model, operation })) return false;
  const maxBatchSize = maxBatchSizeForLlmProvider({ provider, model, operation });
  return !maxBatchSize || Number(batchSize || 0) <= maxBatchSize;
}
