import { pool } from './db.js';
import { cleanTextNoNull } from './text-utils.js';

export async function logLlmRequest({
  operation,
  provider,
  requestedModel,
  resolvedModel = null,
  status,
  categorySlug = null,
  batchSize = 0,
  usage = {},
  latencyMs = null,
  error = null,
  metadata = {},
}) {
  await pool.query(
    `INSERT INTO llm_request_logs (
       operation, provider, requested_model, resolved_model, status, category_slug,
       batch_size, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
       total_tokens, cost_usd, latency_ms, error, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
    [
      operation,
      provider,
      requestedModel,
      resolvedModel,
      status,
      categorySlug,
      batchSize,
      usage.promptTokens || 0,
      usage.completionTokens || 0,
      usage.reasoningTokens || 0,
      usage.cachedTokens || 0,
      usage.totalTokens || 0,
      usage.costUsd,
      latencyMs,
      error ? cleanTextNoNull(error).slice(0, 1000) : null,
      JSON.stringify(metadata),
    ],
  );
}
