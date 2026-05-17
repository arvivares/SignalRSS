CREATE TABLE IF NOT EXISTS llm_provider_cooldowns (
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL,
  reason text NOT NULL,
  cooldown_until timestamptz NOT NULL,
  failure_count integer NOT NULL DEFAULT 1,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, model, operation)
);

CREATE INDEX IF NOT EXISTS llm_provider_cooldowns_until_idx
  ON llm_provider_cooldowns (cooldown_until);
