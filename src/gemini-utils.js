import { config } from './config.js';

export function geminiThinkingConfig(model = '') {
  const normalized = String(model).toLowerCase();

  if (normalized.startsWith('gemini-3')) {
    return { thinkingLevel: config.gemini3ThinkingLevel };
  }

  if (normalized.startsWith('gemini-2.5')) {
    return { thinkingBudget: config.gemini25ThinkingBudget };
  }

  return undefined;
}

export function geminiGenerationConfig({ model, maxOutputTokens, responseJsonSchema, temperature = 0.1 }) {
  const thinkingConfig = geminiThinkingConfig(model);
  return {
    temperature,
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseJsonSchema,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}
