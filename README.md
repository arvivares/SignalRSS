# SignalRSS
SignalRSS agrega, normaliza y redistribuye noticias tecnológicas globales desde múltiples feeds RSS en un único canal actualizado.

## Architecture

SignalRSS is designed as a Docker-first service with these runtime and job components:

- `postgres`: PostgreSQL 18.3 database for feeds, articles, fetch runs, and deduplication.
- `migrator`: applies SQL migrations before the app starts.
- `seeder`: loads the curated final feed list from `data/feeds.csv`.
- `category-seeder`: loads the technology topic taxonomy from `data/topic-categories.json`.
- `backfill`: imports all available articles from the last 7 days.
- `classifier`: classifies recent articles into persistent topic categories using embeddings.
- `api`: exposes health checks and the unified RSS feed at `/rss.xml`.
- `worker`: polls enabled feeds and stores new articles continuously.

See [docs/architecture.md](docs/architecture.md) for the full architecture.

## Local Docker

```bash
cp .env.example .env
docker compose up --build
```

Run the initial seven-day import:

```bash
docker compose --profile jobs run --rm backfill
```

Classify recent articles by topic:

```bash
docker compose --profile jobs run --rm classifier
```

Complete `OPENAI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `.env` before running the classifier. Langfuse traces OpenAI embedding calls so token usage and cost can be reviewed in the Langfuse project.

Run continuous classification for new articles:

```bash
docker compose up -d classifier-worker
```

Cluster classified articles into semantic story groups:

```bash
docker compose --profile jobs run --rm clusterer
docker compose up -d cluster-worker
```

Useful endpoints:

```bash
http://localhost:3000/health
http://localhost:3000/ready
http://localhost:3000/feeds/stats
http://localhost:3000/categories/stats
http://localhost:3000/classification/stats
http://localhost:3000/clusters/stats
http://localhost:3000/api/clusters
http://localhost:3000/rss.xml
http://localhost:3000/rss.xml?category=artificial-intelligence
http://localhost:3000/rss/artificial-intelligence.xml
http://localhost:3000/groups.xml
```
