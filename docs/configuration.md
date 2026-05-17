# Configuration Guide

SignalRSS is configured through environment variables. Copy `.env.example` to `.env`, fill local secrets, and keep `.env` untracked.

## Core runtime

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection used by all application services. |
| `POSTGRES_BIND_ADDRESS` | Host bind address for Postgres. Defaults to `127.0.0.1`. |
| `API_PORT` | Local API port. |
| `API_BIND_ADDRESS` | Host bind address for the API. Defaults to `127.0.0.1`. |
| `RSS_PUBLIC_BASE_URL` | Public base URL used in generated RSS links. |
| `INGEST_WINDOW_DAYS` | Historical window used by backfill. |

Keep `API_BIND_ADDRESS` and `POSTGRES_BIND_ADDRESS` local unless you intentionally place SignalRSS behind a reverse proxy with authentication and TLS.

## RSS ingestion

| Variable | Purpose |
| --- | --- |
| `WORKER_POLL_INTERVAL_SECONDS` | Feed polling cadence. |
| `WORKER_BATCH_SIZE` | Number of feeds handled per polling loop. |
| `FEED_MAX_BYTES` | Maximum RSS/Atom response size. |
| `BACKFILL_CONCURRENCY` | Parallelism for historical backfill. |

All shared HTTP fetches go through URL validation and byte caps to reduce SSRF and unbounded-download risk.

## Classification and clustering

| Variable | Purpose |
| --- | --- |
| `EMBEDDING_MODEL` | Embedding model for article/category vectors. |
| `CLASSIFIER_BATCH_SIZE` | Article classification batch size. |
| `CLASSIFIER_MIN_CONFIDENCE` | Global minimum confidence for category assignment. |
| `CLASSIFIER_MIN_MARGIN` | Global minimum gap between best and next category. |
| `<CATEGORY>_CLUSTER_SIMILARITY_THRESHOLD` | Category-specific cluster threshold. |
| `CLUSTER_WINDOW_DAYS` | Window for active clustering. |

Category-specific thresholds should live in `.env.example` and `.env`, not in one-off cleanup commands. That keeps future clustering behavior reproducible.

## Impact and briefing

| Variable | Purpose |
| --- | --- |
| `IMPACT_MODEL_FALLBACKS` | Ordered provider/model chain for impact scoring. |
| `BRIEFING_MODEL_FALLBACKS` | Ordered provider/model chain for brief generation. |
| `IMPACT_WINDOW_HOURS` | Impact processing window. |
| `BRIEFING_OUTPUT_LANGUAGE` | Target language for generated briefs. |
| `CATEGORY_BRIEFING_EXCLUDE_LEVELS` | Category/priority pairs to skip, such as `consumer-electronics:P3`. |
| `BRIEFING_OPENAI_FALLBACK_LEVELS` | Priority levels allowed to use paid OpenAI fallback. |

Prompts are maintained in code, but language and category guidance are configurable. Keep prompt changes forward-looking unless a specific backfill is required.

## Provider limits and cooldowns

| Variable | Purpose |
| --- | --- |
| `LLM_COOLDOWN_ENABLED` | Enables provider/model cooldown tracking. |
| `LLM_RATE_LIMIT_COOLDOWN_MS` | Cooldown after normal rate limits. |
| `LLM_DAILY_RATE_LIMIT_COOLDOWN_MS` | Cooldown after daily quota exhaustion. |
| `LLM_PAYLOAD_TOO_LARGE_COOLDOWN_MS` | Cooldown after payload-size failures. |
| `LLM_BAD_RESPONSE_COOLDOWN_MS` | Cooldown after invalid model output. |
| `LLM_*_RPM` | Provider-specific request pacing. |
| `LLM_*_IMPACT_MAX_BATCH_SIZE` | Provider-specific impact batch cap. |
| `LLM_*_BRIEFING_MAX_BATCH_SIZE` | Provider-specific briefing batch cap. |
| `LLM_MODEL_POLICY_<PROVIDER>_<MODEL>` | Per-model override for enablement, RPM, quotas, and batch caps. |

Prefer lowering provider-specific batch size before lowering global throughput. That keeps reliable providers useful while protecting weaker ones from large payloads.

Per-model overrides use comma-separated `key=value` pairs. The environment variable name is derived from provider and model by replacing non-alphanumeric characters with `_` and uppercasing them.

Example:

```bash
LLM_MODEL_POLICY_SAMBANOVA_GPT_OSS_120B=impact_enabled=true,briefing_enabled=false
```

Supported keys are `enabled`, `impact_enabled`, `briefing_enabled`, `rpm`, `tpm`, `tpd`, `rpd`, `impact_max_batch_size`, and `briefing_max_batch_size`.

The effective policy is visible at `/api/ops/health` under `providers.policies`.

## Cross-category deduplication

| Variable | Purpose |
| --- | --- |
| `CROSS_CATEGORY_ADJUDICATION_CATEGORIES` | Categories included in cross-category duplicate checks. |
| `CROSS_CATEGORY_ADJUDICATION_LEVELS` | Priority levels included in cross-category duplicate checks. |
| `CROSS_CATEGORY_ADJUDICATION_VECTOR_NEIGHBORS` | pgvector neighbor count used for candidate generation. |
| `CROSS_CATEGORY_ADJUDICATION_ARTICLE_SCAN_MIN_CENTROID_SIMILARITY` | Lower similarity bound for candidate scanning. |
| `MATTERMOST_REQUIRE_CROSS_CATEGORY_CLEARANCE` | Blocks posting while a plausible cross-category duplicate is unresolved. |
| `MATTERMOST_CROSS_CATEGORY_CLEARANCE_MIN_SIMILARITY` | Mattermost pre-publish similarity threshold. |

For publication safety, keep Mattermost clearance enabled. It is cheaper to delay a post than to clean duplicate posts across channels.

## Mattermost

| Variable | Purpose |
| --- | --- |
| `MATTERMOST_ENABLED` | Enables or disables posting. |
| `MATTERMOST_WEBHOOK_URL` | Incoming webhook URL. Keep it secret. |
| `MATTERMOST_LEVELS` | Priorities eligible for posting. |
| `MATTERMOST_CHANNELS_BY_CATEGORY` | Category-to-channel mapping. |
| `MATTERMOST_USERNAME` | Webhook display name, if the integration allows override. |
| `MATTERMOST_GENERATE_MISSING_THUMBNAILS` | Generates an image when source thumbnails are missing or too small. |
| `MATTERMOST_IMAGE_UPLOAD_ENABLED` | Uploads generated images to an external temporary host. |

Use category-specific channels instead of one global channel when the audience differs by topic.

## Langfuse

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key. |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key. |
| `LANGFUSE_BASE_URL` | Langfuse endpoint. |

Langfuse is optional for local development, but recommended when impact, briefing, and image generation are enabled because it makes provider cost and quality observable.
