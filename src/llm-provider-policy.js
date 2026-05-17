import { config } from './config.js';

export function maxBatchSizeForLlmProvider({ provider, model, operation }) {
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
  const maxBatchSize = maxBatchSizeForLlmProvider({ provider, model, operation });
  return !maxBatchSize || Number(batchSize || 0) <= maxBatchSize;
}
