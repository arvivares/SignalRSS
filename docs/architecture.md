# SignalRSS Architecture

SignalRSS is a Docker-first news intelligence pipeline. It ingests curated technology RSS feeds, stores canonical articles, classifies them into persistent categories, clusters related stories, scores their impact, generates Spanish briefs, and publishes selected stories through RSS, the web UI, and Mattermost.

## Runtime services

| Service | Responsibility |
| --- | --- |
| `postgres` | PostgreSQL 18 through `pgvector/pgvector:pg18`; stores feeds, articles, embeddings, clusters, jobs, briefings, Mattermost state, and swipe decisions. |
| `migrator` | Applies `db/migrations/*.sql` before application services start. |
| `seeder` | Loads the curated feed list from `data/feeds.csv`. |
| `category-seeder` | Loads the category taxonomy from `data/topic-categories.json`. |
| `api` | Serves the dashboard, RSS feeds, JSON APIs, cluster pages, briefing pages, and `/news`. |
| `worker` | Polls enabled RSS feeds and stores new canonical articles. |
| `classifier-worker` | Embeds new articles and persists category assignments. |
| `category-cluster-worker` | Groups classified articles into semantic story clusters by category. |
| `category-impact-worker-*` | Scores clusters as `P0`, `P1`, `P2`, or `P3` using configured LLM fallbacks. |
| `category-adjudication-worker` | Detects and merges duplicate clusters inside each category and priority level. |
| `cross-category-adjudication-worker` | Detects duplicate stories across categories and applies merge precedence rules. |
| `cluster-merge-worker` | Applies approved cluster merges. |
| `category-briefing-worker` | Generates localized briefs for scored clusters. |
| `mattermost-worker` | Publishes configured priority briefs to Mattermost with deduplication and thumbnail handling. |

One-shot services such as `backfill`, `classifier`, `clusterer`, `impact-scorer`, and `p0` to `p3` briefing/adjudication jobs exist for maintenance and controlled reprocessing. The nominal runtime uses the continuous workers.

## Data model

`feeds` stores source metadata, country, timezone, validation status, retry state, `etag`, and `last_modified`.

`articles` stores canonical article data. Deduplication is based on source identity, canonical URL, GUID, and content hash.

`feed_entries` maps source feed entries to canonical articles, allowing multiple feeds to reference the same story without duplicating the article.

`fetch_runs` records polling attempts and failures for feed observability.

`topic_categories` stores the technology category taxonomy and category embeddings.

`article_embeddings` stores article vectors for the active embedding model. pgvector indexes support similarity search.

`article_classifications` stores ranked category assignments, confidence, margin, model, and method.

`article_classification_rejections` records articles rejected from category assignment and why.

`story_clusters` stores semantic story groups, priority level, centroid vectors, cluster state, and category ownership.

`cluster_articles` maps articles to clusters and stores assignment similarity.

`cluster_impact_scores` stores `P0` to `P3` impact decisions and supporting rationale.

`cluster_impact_jobs` tracks scoring jobs, attempts, stale claims, retries, and failures.

`cluster_briefings` stores localized title, summary, links, story hash, and versioned briefing output.

`mattermost_notifications` and related notification tables track posting state, idempotency, snapshots, failures, and global story deduplication.

`llm_request_logs` stores provider/model outcomes for cost, reliability, and fallback analysis.

`llm_provider_cooldowns` stores provider cooldowns so workers can avoid repeatedly hitting known rate limits or failing models.

`news_swipes` stores `/news` left/right decisions by cluster and priority level.

## Processing flow

1. `postgres` starts and passes its healthcheck.
2. `migrator` applies database migrations.
3. `seeder` and `category-seeder` upsert feeds and categories.
4. `backfill` can import the last `INGEST_WINDOW_DAYS` on demand.
5. `worker` polls feeds continuously and writes new articles.
6. `classifier-worker` embeds and classifies unclassified articles.
7. `category-cluster-worker` assigns classified articles to story clusters.
8. `category-impact-worker-*` creates or resumes impact jobs and scores clusters.
9. `category-adjudication-worker` validates duplicate clusters within categories and priorities.
10. `cross-category-adjudication-worker` validates duplicates across categories.
11. `cluster-merge-worker` applies merge decisions.
12. `category-briefing-worker` generates briefs for eligible priorities.
13. `mattermost-worker` publishes configured briefs after deduplication.
14. `api` exposes current state through pages, JSON endpoints, and RSS 2.0 feeds.

## Architectural boundaries

SignalRSS keeps long-running responsibilities separated so failures are isolated and queues can be drained independently:

- Ingestion workers never call LLMs. They only fetch, normalize, and store articles.
- Classification and clustering own semantic placement. They do not publish.
- Impact and briefing workers own expensive model calls and provider fallback behavior.
- Adjudication workers own duplicate decisions and merge eligibility.
- Mattermost publishing is a final side effect and must stay downstream from duplicate clearance.
- The API reads current state and records explicit `/news` swipe actions; it should not perform background pipeline work.

When adding new features, prefer extending one boundary instead of adding cross-cutting behavior inside several workers. For example, a new publication target should reuse briefing and duplicate-clearance state instead of creating its own scoring or clustering path.

## Impact and briefing pipeline

Impact scoring and briefing generation use provider fallback chains. Free or lower-cost providers are attempted first, and OpenAI is kept as the paid final fallback.

The default fallback chains are configured through:

```bash
IMPACT_MODEL_FALLBACKS=
BRIEFING_MODEL_FALLBACKS=
```

Provider cooldown and batch controls are configured through `LLM_*` variables. This lets the stack reduce load on providers that return rate limits, payload-size errors, transport failures, or invalid responses.

Brief output language is configurable:

```bash
BRIEFING_OUTPUT_LANGUAGE=Spanish
```

`CATEGORY_BRIEFING_EXCLUDE_LEVELS` can skip low-value briefing work, for example:

```bash
CATEGORY_BRIEFING_EXCLUDE_LEVELS=consumer-electronics:P3
```

## Deduplication strategy

SignalRSS deduplicates at several layers:

- Article-level deduplication prevents the same source story from being stored repeatedly.
- Category clustering groups semantically similar articles inside the same topic.
- Priority adjudication detects duplicate clusters within the same category and across priority levels.
- Cross-category adjudication detects similar stories that landed in different categories.
- Mattermost global story deduplication prevents reposting the same story in multiple channels.

When cross-category clusters are merged, precedence is based on impact level first, then article count, then category preference.

## Publication clearance

Mattermost publishing is intentionally downstream from duplicate validation. A cluster is eligible to post only after these checks pass:

- No previous `mattermost_notifications` row exists for the same `story_hash` and locale in a blocking status.
- No cross-category adjudication has already marked the cluster as `same_story` with a posted counterpart.
- No unresolved `same_story` cross-category adjudication still references the cluster.
- If `MATTERMOST_REQUIRE_CROSS_CATEGORY_CLEARANCE=true`, no unadjudicated cross-category cluster in the Mattermost window has centroid similarity greater than or equal to `MATTERMOST_CROSS_CATEGORY_CLEARANCE_MIN_SIMILARITY`.

The last rule is the pre-publish safety gate. It prevents Mattermost from publishing a P0 before the cross-category worker has had a chance to decide whether the story is a duplicate in another category. If the gate holds a cluster, the cross-category adjudication worker should process the candidate first; the Mattermost worker can publish after the candidate is adjudicated as distinct/related, or after a same-story merge resolves it into the winning cluster.

## Mattermost publishing

Mattermost publishing is opt-in through:

```bash
MATTERMOST_ENABLED=true
MATTERMOST_WEBHOOK_URL=
MATTERMOST_CHANNELS_BY_CATEGORY=
```

The worker publishes configured levels from `MATTERMOST_LEVELS`, currently typically `P0`. It can extract thumbnails from source links, generate missing thumbnails, upload generated images to a temporary hosting provider, and store notification state to avoid duplicate posts.

Generated thumbnails are local runtime artifacts and should not be committed.

## Public interfaces

| Endpoint | Purpose |
| --- | --- |
| `/` | Dashboard with feed counts, queues, provider outcomes, Mattermost status, and swipe summaries. |
| `/news` | Mobile-first swipe interface for priority clusters. |
| `/rss.xml` | Unified RSS 2.0 feed. |
| `/rss.xml?category=<slug>` | Unified RSS filtered by category. |
| `/rss/<slug>.xml` | Category-specific RSS 2.0 feed. |
| `/groups.xml` | Grouped story RSS feed. |
| `/api/clusters` | Cluster JSON API. |
| `/api/news` | Queue data for the `/news` UI. |
| `/api/news/swipe` | Records `/news` swipe decisions. |
| `/api/news/interested` | Lists selected stories. |
| `/feeds/stats` | Feed health and ingestion stats. |
| `/categories/stats` | Category stats. |
| `/classification/stats` | Classification stats. |
| `/clusters/stats` | Cluster stats. |
| `/impact/stats` | Impact scoring stats. |

## Observability

Langfuse traces are used for LLM-backed work where supported by the application. Provider outcomes are also stored in `llm_request_logs`, which makes it possible to compare success rates, latency, model fallbacks, and cost-driving behavior.

Operational state is visible in the home dashboard and through container logs:

```bash
docker compose ps
docker compose logs -f category-impact-worker
docker compose logs -f category-briefing-worker
docker compose logs -f mattermost-worker
```

The database is the source of truth for queue state. Logs explain recent behavior, but status tables such as `cluster_impact_jobs`, `cluster_briefings`, `llm_request_logs`, and `mattermost_notifications` should be used to decide whether a queue is stuck or simply waiting on cooldown.

## Local commands

Start the stack:

```bash
cp .env.example .env
docker compose up --build
```

Start the nominal runtime shape:

```bash
docker compose -f docker-compose.yml -f compose.nominal.yml up -d --build
```

Run the initial seven-day import:

```bash
docker compose --profile jobs run --rm backfill
```

Validate Docker Compose:

```bash
docker compose config --quiet
```

## Version policy

Use stable service and library versions intentionally. PostgreSQL major versions require explicit migration planning because data directories are tied to the major version. The current database image is `pgvector/pgvector:pg18`.

## Public repository policy

The repository is public. Keep `.env`, generated images, SQL dumps, logs, and provider experiments out of Git. Run `npm run validate` before committing to execute tests and the tracked-file public repository scan.
