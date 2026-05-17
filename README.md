# SignalRSS

SignalRSS ingests global technology RSS feeds, stores normalized articles in PostgreSQL, clusters related stories, scores their impact, generates Spanish briefs, and republishes the result through a unified RSS feed, a web UI, and Mattermost channels.

The system is Docker-first. It is designed to keep running continuously: feed polling, classification, semantic clustering, cross-category deduplication, impact scoring, briefing generation, and Mattermost publishing all run as independent workers.

## What SignalRSS does

- Ingests curated RSS/Atom feeds from `data/feeds.csv`.
- Stores canonical articles, feed entries, fetch runs, embeddings, categories, story clusters, impact jobs, briefs, and user swipes in PostgreSQL with pgvector.
- Classifies articles into persistent technology categories from `data/topic-categories.json`.
- Groups related articles into semantic story clusters per category.
- Detects duplicate or near-duplicate clusters inside a category and across categories.
- Scores clusters as `P0`, `P1`, `P2`, or `P3`.
- Generates Spanish briefs with title, summary, and source links.
- Publishes selected `P0` briefs to Mattermost by category.
- Serves a consolidated RSS 2.0 feed and a mobile-first `/news` swipe UI.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | API routes, workers, LLM orchestration, RSS ingestion, clustering, scoring, briefings, and Mattermost publishing. |
| `db/migrations/` | PostgreSQL schema migrations. |
| `data/feeds.csv` | Curated feed list loaded by the seeder. |
| `data/topic-categories.json` | Persistent technology category taxonomy. |
| `docs/architecture.md` | Detailed architecture notes. |
| `docker-compose.yml` | Full local stack and worker definitions. |
| `compose.nominal.yml` | Nominal runtime override for the steady-state stack. |
| `.env.example` | Safe configuration template. Copy it to `.env` and fill secrets locally. |

## Keep secrets out of Git

Do not commit `.env`, database dumps, generated thumbnails, logs, or local databases. The repository keeps `.env.example` tracked because it contains empty placeholders only.

Ignored by default:

- `.env` and `.env.*`
- `node_modules/`
- SQL dumps and backups such as `signalrss-pre-pgvector.sql`
- generated thumbnails under `data/generated-thumbnails/`
- local logs, SQLite files, and temporary files

Before committing, run:

```bash
git status --short
git diff --cached --check
```

## Start locally with Docker

Create a local environment file:

```bash
cp .env.example .env
```

Fill the provider keys you want to use in `.env`. `OPENAI_API_KEY` is the paid fallback. Langfuse keys are optional for running the stack, but required if you want cost and trace visibility.

Start the stack:

```bash
docker compose up --build
```

Or, on Windows/WSL when Docker is exposed through Docker Desktop:

```bash
powershell.exe -NoProfile -Command "Set-Location 'C:\Users\aa9936\Downloads\rss\SignalRSS'; docker.exe compose up --build"
```

Check health:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## Load historical articles

Run the initial seven-day backfill:

```bash
docker compose --profile jobs run --rm backfill
```

By default the backfill uses `INGEST_WINDOW_DAYS=7`. Change it in `.env` if you need a different window.

## Run the nominal pipeline

The steady-state flow is:

1. `worker` polls RSS feeds and stores new articles.
2. `classifier-worker` embeds and classifies articles.
3. `category-cluster-worker` groups articles into story clusters.
4. `category-impact-worker-*` scores clusters by impact.
5. `category-adjudication-worker` validates duplicate clusters by priority.
6. `cross-category-adjudication-worker` validates duplicate clusters across categories.
7. `category-briefing-worker` generates Spanish briefs.
8. `mattermost-worker` publishes configured `P0` briefs.
9. `api` serves the dashboard, RSS feeds, cluster views, briefs, and `/news`.

Use the nominal compose file when you want the configured runtime shape:

```bash
docker compose -f docker-compose.yml -f compose.nominal.yml up -d --build
```

Inspect running services:

```bash
docker compose ps
```

Follow logs for one service:

```bash
docker compose logs -f category-impact-worker
```

## Main URLs

| URL | Description |
| --- | --- |
| `http://localhost:3000/` | Home dashboard with feed, queue, provider, and Mattermost metrics. |
| `http://localhost:3000/news` | Mobile-first swipe UI for `P0` to `P3` clusters. |
| `http://localhost:3000/rss.xml` | Unified RSS 2.0 feed. |
| `http://localhost:3000/rss.xml?category=artificial-intelligence` | Unified RSS filtered by category. |
| `http://localhost:3000/rss/artificial-intelligence.xml` | Category RSS feed. |
| `http://localhost:3000/groups.xml` | Grouped story RSS feed. |
| `http://localhost:3000/api/clusters` | JSON cluster API. |
| `http://localhost:3000/feeds/stats` | Feed ingestion stats. |
| `http://localhost:3000/categories/stats` | Category stats. |
| `http://localhost:3000/classification/stats` | Classification stats. |
| `http://localhost:3000/clusters/stats` | Cluster stats. |

## LLM providers and tracing

SignalRSS can use multiple LLM providers before falling back to OpenAI. Configure them in `.env`:

- OpenAI
- OpenRouter
- Groq
- NVIDIA
- Cerebras
- SambaNova
- Mistral
- LLMRack
- Cloudflare Workers AI
- GitHub Models
- Gemini

Langfuse tracing is wired into embedding, impact, briefing, and image generation paths where supported by the application. Set:

```bash
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Provider fallback order, cooldowns, request limits, and per-provider batch sizes are controlled through the `LLM_*`, `IMPACT_MODEL_FALLBACKS`, and `BRIEFING_MODEL_FALLBACKS` variables in `.env`.

## Mattermost publishing

Mattermost publishing is controlled by:

```bash
MATTERMOST_ENABLED=true
MATTERMOST_WEBHOOK_URL=
MATTERMOST_USERNAME=SignalRSS
MATTERMOST_LEVELS=P0
MATTERMOST_CHANNELS_BY_CATEGORY=artificial-intelligence:news-ai,cloud-infrastructure:news-cloud
```

The webhook can override username and channel only if the Mattermost integration allows it. `mattermost-worker` uses idempotency and cross-category deduplication so the same story should not be posted repeatedly across configured categories.

Generated thumbnails are stored locally under `data/generated-thumbnails/` and are intentionally ignored by Git.

## Common maintenance commands

Run migrations:

```bash
npm run db:migrate
```

Seed feeds and categories:

```bash
npm run seed:feeds
npm run seed:categories
```

Run one-shot classification:

```bash
npm run classify:articles
```

Run one-shot clustering:

```bash
npm run cluster:articles
```

Recluster one category:

```bash
npm run maintenance:recluster-category -- software-development
```

Clean low-confidence classifications:

```bash
npm run maintenance:cleanup-low-confidence
```

## Development checks

Validate JavaScript syntax for changed files:

```bash
node --check src/config.js
node --check src/api.js
node --check src/score-impact.js
```

Validate Docker Compose:

```bash
docker compose config --quiet
```

Check what will be committed:

```bash
git status --short
git diff --stat
```

## More documentation

Read [docs/architecture.md](docs/architecture.md) for the service flow, data model, and Docker startup sequence.
