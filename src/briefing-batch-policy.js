import { config } from './config.js';
import { maxBatchSizeForLlmProvider } from './llm-provider-policy.js';

export function batchSizeForBriefingProviders(providers = []) {
  const operation = 'briefing_generation';
  const nonOpenAiProviders = providers.filter((provider) => provider.provider !== 'openai');
  const unboundedFreeProviders = nonOpenAiProviders.filter((provider) => !maxBatchSizeForLlmProvider({
    provider: provider.provider,
    model: provider.model,
    operation,
  }));
  const boundedFreeBatchSizes = nonOpenAiProviders
    .map((provider) => maxBatchSizeForLlmProvider({
      provider: provider.provider,
      model: provider.model,
      operation,
    }))
    .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    .map(Number);

  if (nonOpenAiProviders.length > 0) {
    const defaultFreeBatchSize = Math.max(1, Number(config.categoryBriefingFreeBatchSize) || 1);
    if (unboundedFreeProviders.length > 0) return defaultFreeBatchSize;
    if (boundedFreeBatchSizes.length === 0) return defaultFreeBatchSize;
    return Math.max(1, Math.min(defaultFreeBatchSize, ...boundedFreeBatchSizes));
  }

  if (providers.some((provider) => provider.provider === 'openai')) return config.categoryBriefingOpenAiBatchSize;
  return undefined;
}
