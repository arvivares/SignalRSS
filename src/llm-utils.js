export function responseText(response = {}) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('');
}

export function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model response did not contain JSON object');
    return JSON.parse(match[0]);
  }
}

export function usageFromChatCompletion(body = {}) {
  const usage = body.usage || {};
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const outputDetails = usage.completion_tokens_details || usage.output_tokens_details || {};
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: Number(usage.total_tokens || input + output),
    cachedTokens: Number(details.cached_tokens || 0),
    reasoningTokens: Number(outputDetails.reasoning_tokens || 0),
    costUsd: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
  };
}

export function estimateOpenAITextCostUsd(model = '', usage = {}) {
  const normalizedModel = String(model || '').toLowerCase();
  if (!normalizedModel.startsWith('gpt-5-nano')) return null;

  const input = Number(usage.input || 0);
  const cached = Math.min(input, Number(usage.cached || 0));
  const uncachedInput = Math.max(0, input - cached);
  const output = Number(usage.output || 0);

  return Number((
    uncachedInput * 0.00000005
    + cached * 0.000000005
    + output * 0.0000004
  ).toFixed(8));
}

export function usageFromOpenAIResponse(response = {}) {
  const usage = response.usage || {};
  const input = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const output = Number(usage.output_tokens || usage.completion_tokens || 0);
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: Number(usage.total_tokens || input + output),
    cachedTokens: Number(details.cached_tokens || 0),
    reasoningTokens: Number(outputDetails.reasoning_tokens || 0),
    costUsd: estimateOpenAITextCostUsd(response.model, {
      input,
      output,
      cached: Number(details.cached_tokens || 0),
    }),
  };
}
