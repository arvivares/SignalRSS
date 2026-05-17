import { config } from './config.js';
import { pool } from './db.js';
import { llmKnownLimit } from './llm-provider-policy.js';

const GLOBAL_OPERATION = 'global';

let ensured = false;

function normalizeText(value = '') {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

async function ensureCooldownTable() {
  if (ensured) return;
  await pool.query(`
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
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS llm_provider_cooldowns_until_idx
      ON llm_provider_cooldowns (cooldown_until)
  `);
  ensured = true;
}

function knownLimit(provider, model) {
  return llmKnownLimit({ provider, model });
}

function spacingMs(provider, model) {
  const limit = knownLimit(provider, model);
  if (!limit?.rpm) return 0;
  return Math.ceil(60000 / limit.rpm);
}

function parseRetryDurationMs(message) {
  const text = String(message || '').toLowerCase();
  const retryAfterSeconds = text.match(/retry-after[^0-9]*(\d+)/);
  if (retryAfterSeconds) return Number(retryAfterSeconds[1]) * 1000;

  const tryAgain = text.match(/(?:try again|retry) in\s*([0-9hms.\s]+)/);
  if (!tryAgain) return null;

  let totalMs = 0;
  for (const [, amount, unit] of tryAgain[1].matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g)) {
    const value = Number(amount);
    if (unit === 'h') totalMs += value * 60 * 60 * 1000;
    if (unit === 'm') totalMs += value * 60 * 1000;
    if (unit === 's') totalMs += value * 1000;
  }
  return totalMs > 0 ? totalMs : null;
}

function integerMilliseconds(value, fallback = config.llmMinCooldownMs) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return Math.ceil(fallback);
  return Math.ceil(ms);
}

function classifyFailure(provider, model, error, previousFailures = 0) {
  const message = normalizeText(error?.message || error);
  const text = message.toLowerCase();
  const retryMs = parseRetryDurationMs(message);
  const limit = knownLimit(provider, model);

  if (
    text.includes('tokens_limit_reached')
    || text.includes('request body too large')
    || text.includes('max size:')
    || text.includes('payload too large')
    || text.includes('413')
  ) {
    return {
      reason: 'payload_too_large',
      cooldownMs: config.llmPayloadTooLargeCooldownMs,
    };
  }

  if (
    text.includes('tokens per day')
    || text.includes('1-day token limit')
    || text.includes('tpd')
    || text.includes('requests per day')
    || text.includes('daily free allocation')
    || text.includes('used up your daily')
    || text.includes('exceeded your current quota')
    || text.includes('quota exceeded')
  ) {
    return {
      reason: 'daily_rate_limit',
      cooldownMs: retryMs || config.llmDailyRateLimitCooldownMs,
    };
  }

  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    const baseMs = retryMs || (limit?.rpm ? Math.ceil(60000 / limit.rpm) * 2 : config.llmRateLimitCooldownMs);
    return {
      reason: 'rate_limit',
      cooldownMs: Math.max(baseMs, config.llmRateLimitCooldownMs),
    };
  }

  if (text.includes('timeout') || text.includes('aborted') || text.includes('econnreset') || text.includes('fetch failed')) {
    return {
      reason: 'transport_error',
      cooldownMs: config.llmTransportErrorCooldownMs * Math.min(previousFailures + 1, 4),
    };
  }

  if (text.includes('invalid json') || text.includes('missing results') || text.includes('did not contain json')) {
    return {
      reason: 'bad_model_response',
      cooldownMs: config.llmBadResponseCooldownMs * Math.min(previousFailures + 1, 3),
    };
  }

  return {
    reason: 'model_error',
    cooldownMs: config.llmModelErrorCooldownMs * Math.min(previousFailures + 1, 3),
  };
}

export async function getLlmCooldown({ provider, model, operation }) {
  if (!config.llmCooldownEnabled || !provider || !model) return null;
  await ensureCooldownTable();
  const { rows } = await pool.query(`
    SELECT provider, model, operation, reason, cooldown_until, failure_count, last_error
    FROM llm_provider_cooldowns
    WHERE provider = $1
      AND model = $2
      AND operation = ANY($3::text[])
      AND cooldown_until > NOW()
    ORDER BY cooldown_until DESC
    LIMIT 1
  `, [provider, model, [operation, GLOBAL_OPERATION]]);
  return rows[0] || null;
}

export async function reserveLlmProviderSlot({ provider, model, operation }) {
  if (!config.llmCooldownEnabled || !provider || !model) return { reserved: true, cooldown: null };
  await ensureCooldownTable();

  const ms = spacingMs(provider, model);
  if (ms <= 0) {
    const cooldown = await getLlmCooldown({ provider, model, operation });
    return { reserved: !cooldown, cooldown };
  }

  const { rows } = await pool.query(`
    WITH active_cooldown AS (
      SELECT provider, model, operation, reason, cooldown_until, failure_count, last_error
      FROM llm_provider_cooldowns
      WHERE provider = $1
        AND model = $2
        AND operation = ANY($3::text[])
        AND cooldown_until > NOW()
      ORDER BY cooldown_until DESC
      LIMIT 1
    ),
    reserved_slot AS (
      INSERT INTO llm_provider_cooldowns (
        provider, model, operation, reason, cooldown_until, failure_count, last_error, updated_at
      )
      SELECT $1, $2, $4, 'rpm_spacing', NOW() + ($5::int * INTERVAL '1 millisecond'), 0, NULL, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM active_cooldown)
      ON CONFLICT (provider, model, operation) DO UPDATE SET
        reason = EXCLUDED.reason,
        cooldown_until = EXCLUDED.cooldown_until,
        failure_count = 0,
        last_error = NULL,
        updated_at = NOW()
      WHERE llm_provider_cooldowns.cooldown_until <= NOW()
      RETURNING provider, model, operation, reason, cooldown_until, failure_count, last_error
    )
    SELECT *, false AS reserved
    FROM active_cooldown
    UNION ALL
    SELECT *, true AS reserved
    FROM reserved_slot
    LIMIT 1
  `, [provider, model, [operation, GLOBAL_OPERATION], GLOBAL_OPERATION, ms]);

  const row = rows[0] || null;
  if (row?.reserved) return { reserved: true, cooldown: null };
  return { reserved: false, cooldown: row };
}

export function cooldownSummary(cooldown) {
  if (!cooldown) return '';
  return `${cooldown.reason} until ${new Date(cooldown.cooldown_until).toISOString()}`;
}

export async function recordLlmSuccess({ provider, model, operation }) {
  if (!config.llmCooldownEnabled || !provider || !model) return;
  await ensureCooldownTable();
  await pool.query(`
    DELETE FROM llm_provider_cooldowns
    WHERE provider = $1
      AND model = $2
      AND operation = $3
      AND reason <> 'rpm_spacing'
  `, [provider, model, operation]);

  const ms = spacingMs(provider, model);
  if (ms <= 0) return;

  await pool.query(`
    INSERT INTO llm_provider_cooldowns (
      provider, model, operation, reason, cooldown_until, failure_count, last_error, updated_at
    )
    VALUES ($1, $2, $3, 'rpm_spacing', NOW() + ($4::int * INTERVAL '1 millisecond'), 0, NULL, NOW())
    ON CONFLICT (provider, model, operation) DO UPDATE SET
      reason = EXCLUDED.reason,
      cooldown_until = GREATEST(llm_provider_cooldowns.cooldown_until, EXCLUDED.cooldown_until),
      failure_count = 0,
      last_error = NULL,
      updated_at = NOW()
  `, [provider, model, GLOBAL_OPERATION, ms]);
}

export async function recordLlmFailure({ provider, model, operation, error }) {
  if (!config.llmCooldownEnabled || !provider || !model) return null;
  await ensureCooldownTable();
  const { rows } = await pool.query(`
    SELECT failure_count
    FROM llm_provider_cooldowns
    WHERE provider = $1
      AND model = $2
      AND operation = $3
  `, [provider, model, operation]);
  const previousFailures = Number(rows[0]?.failure_count || 0);
  const failure = classifyFailure(provider, model, error, previousFailures);
  const cooldownMs = integerMilliseconds(Math.min(
    Math.max(failure.cooldownMs, config.llmMinCooldownMs),
    config.llmMaxCooldownMs,
  ));
  const message = normalizeText(error?.message || error).slice(0, 1000);

  await pool.query(`
    INSERT INTO llm_provider_cooldowns (
      provider, model, operation, reason, cooldown_until, failure_count, last_error, updated_at
    )
    VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 millisecond'), $6, $7, NOW())
    ON CONFLICT (provider, model, operation) DO UPDATE SET
      reason = EXCLUDED.reason,
      cooldown_until = EXCLUDED.cooldown_until,
      failure_count = llm_provider_cooldowns.failure_count + 1,
      last_error = EXCLUDED.last_error,
      updated_at = NOW()
  `, [
    provider,
    model,
    operation,
    failure.reason,
    cooldownMs,
    previousFailures + 1,
    message,
  ]);

  if (failure.reason === 'rate_limit' || failure.reason === 'daily_rate_limit') {
    await pool.query(`
      INSERT INTO llm_provider_cooldowns (
        provider, model, operation, reason, cooldown_until, failure_count, last_error, updated_at
      )
      VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 millisecond'), $6, $7, NOW())
      ON CONFLICT (provider, model, operation) DO UPDATE SET
        reason = EXCLUDED.reason,
        cooldown_until = GREATEST(llm_provider_cooldowns.cooldown_until, EXCLUDED.cooldown_until),
        failure_count = GREATEST(llm_provider_cooldowns.failure_count, EXCLUDED.failure_count),
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
    `, [
      provider,
      model,
      GLOBAL_OPERATION,
      failure.reason,
      cooldownMs,
      previousFailures + 1,
      message,
    ]);
  }

  return { ...failure, cooldownMs };
}
