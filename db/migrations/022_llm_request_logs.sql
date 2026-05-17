CREATE TABLE IF NOT EXISTS llm_request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  resolved_model TEXT,
  status TEXT NOT NULL,
  category_slug TEXT,
  batch_size INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 8),
  latency_ms INTEGER,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created_operation
  ON llm_request_logs (created_at DESC, operation);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_provider_model
  ON llm_request_logs (provider, requested_model, status, created_at DESC);
