# SignalRSS Architecture

SignalRSS ingests technology RSS feeds, stores normalized article data, and republishes a unified RSS channel.

## Runtime Services

| Service | Responsibility |
| --- | --- |
| `postgres` | PostgreSQL 18.3 source of truth for feeds, articles, fetch history, and state. |
| `migrator` | Applies SQL migrations before API and worker start. |
| `seeder` | Loads the curated final feed list from `data/feeds.csv` into PostgreSQL. |
| `category-seeder` | Loads the technology category taxonomy from `data/topic-categories.json`. |
| `backfill` | One-shot job that imports all available articles from the last 7 days. |
| `classifier` | One-shot job that embeds recent articles and persists topic classifications. |
| `classifier-worker` | Continuously classifies new articles and reports embedding usage to Langfuse. |
| `clusterer` | One-shot job that groups classified articles into semantic story clusters. |
| `cluster-worker` | Continuously clusters newly classified articles. |
| `api` | Exposes `/health`, `/ready`, `/feeds/stats`, `/categories/stats`, and `/rss.xml`. |
| `worker` | Polls enabled feeds continuously, records fetch runs, and stores new articles. |

## Data Model

`feeds` stores source metadata, status, retry state, `etag`, and `last_modified`.

`articles` stores canonical articles. It supports deduplication through `guid`, `canonical_url`, and `content_hash`.

`feed_entries` maps a source feed to a canonical article. This allows the same story to appear in multiple feeds without duplicating the article.

`fetch_runs` records every polling attempt for observability and debugging.

`topic_categories` stores the persistent technology taxonomy and each category embedding.

`article_embeddings` stores article vectors for the active embedding model.

`article_classifications` stores ranked category assignments per article, including confidence, method, and model.

`classification_runs` records classifier executions for observability and debugging.

Langfuse traces OpenAI embedding calls from the classifier. This provides per-run token and cost visibility for category classification.

`story_clusters` stores semantic story groups built from article embeddings.

`cluster_articles` maps articles to story clusters and records assignment similarity.

`clustering_runs` records semantic clustering executions.

## Docker Flow

1. `postgres` starts and passes healthcheck.
2. `migrator` applies `db/migrations/*.sql`.
3. `seeder` upserts the final curated feeds from `data/feeds.csv`.
4. `category-seeder` upserts topic categories from `data/topic-categories.json`.
5. `backfill` can be run on demand to import all available items from the last `INGEST_WINDOW_DAYS`.
6. `classifier` can be run on demand to classify recent articles with embeddings.
7. `classifier-worker` runs continuously and classifies articles that are missing topic assignments.
8. `cluster-worker` runs continuously and groups classified articles into semantic stories.
9. `api` starts and serves the consolidated feed.
10. `worker` polls feeds repeatedly based on `WORKER_POLL_INTERVAL_SECONDS`.

PostgreSQL 18 mounts the persistent volume at `/var/lib/postgresql` so the official image can manage major-version-specific data directories.

## Version Policy

Use the latest stable service and library versions verified before each upgrade. Database major versions should be updated intentionally because PostgreSQL data directories are tied to the major version.

## Local Commands

```bash
cp .env.example .env
docker compose up --build
```

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/feeds/stats
curl http://localhost:3000/categories/stats
curl http://localhost:3000/classification/stats
curl http://localhost:3000/clusters/stats
curl http://localhost:3000/api/clusters
curl http://localhost:3000/rss.xml
curl 'http://localhost:3000/rss.xml?category=artificial-intelligence'
curl http://localhost:3000/rss/artificial-intelligence.xml
curl http://localhost:3000/groups.xml
```

Run the initial seven-day import:

```bash
docker compose --profile jobs run --rm backfill
```

Classify recent articles:

```bash
docker compose --profile jobs run --rm classifier
```

Fill `OPENAI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `.env` before running the classifier.

Run continuous classification:

```bash
docker compose up -d classifier-worker
```

Run semantic clustering:

```bash
docker compose --profile jobs run --rm clusterer
docker compose up -d cluster-worker
```

## Next Implementation Step

Add semantic story clustering on top of stored article embeddings.
