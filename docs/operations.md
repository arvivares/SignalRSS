# Operating SignalRSS

This guide covers the steady-state runtime, queue checks, temporary drains, and safe public-repository practices.

## Run the nominal stack

Use the nominal compose shape for normal operation:

```bash
docker.exe compose -f docker-compose.yml -f compose.nominal.yml up -d --build
```

Check service status:

```bash
docker.exe compose ps
```

The expected long-running services are:

- `api`
- `worker`
- `classifier-worker`
- `category-cluster-worker`
- `category-impact-worker-*`
- `category-adjudication-worker`
- `cross-category-adjudication-worker`
- `cluster-merge-worker`
- `category-briefing-worker`
- `mattermost-worker`

Avoid leaving temporary drain services running after a backlog is cleared.


## Check readiness

Use the API readiness endpoint:

```bash
curl -sS http://127.0.0.1:3000/api/ready
```

Use the dashboard for a human-readable view:

```bash
http://127.0.0.1:3000/
```

The dashboard should show feed health, pending work by category, provider outcomes, Mattermost posts, and `/news` swipe summaries.

Use the operational health endpoint for automation:

```bash
curl -sS http://127.0.0.1:3000/api/ops/health
```

It returns queue totals, stale briefing claims, active provider cooldowns, historical cooldowns for disabled providers, last-hour provider outcomes, database table health, recent Mattermost status, and feed health. A non-`ok` status returns HTTP `503` so scripts can fail fast.

## Understand the queues

The normal order is:

1. Feed polling creates canonical articles.
2. Classification creates category assignments.
3. Category clustering creates story clusters.
4. Impact scoring assigns `P0` to `P3`.
5. Same-category adjudication merges duplicates.
6. Cross-category adjudication merges duplicates across categories.
7. Briefing creates localized story summaries.
8. Mattermost publishing posts eligible `P0` briefs.

Impact and briefing workers are independent. A stalled impact queue does not automatically stop briefing work for clusters that already have impact scores.

## Drain temporary backlogs

Prefer changing worker counts through Compose overrides instead of starting ad hoc containers. If you create a temporary drain file, name it clearly, keep it out of the nominal path, and remove the services after the queue clears.

Before scaling up paid fallback workers, confirm why free providers are not draining:

```bash
docker.exe compose logs --tail=200 category-impact-worker
docker.exe compose logs --tail=200 category-briefing-worker
```

Common reasons:

- Provider daily quota exhausted.
- Provider RPM/TPM limit hit.
- Provider was skipped by the preventive daily budget guard.
- Payload too large for a specific provider.
- Model returned invalid JSON.
- Claim is stale and waiting for retry.

Use OpenAI drain workers only as a deliberate cost tradeoff.

If `/api/ops/health` shows cooldowns under `inactiveHistoricalCooldowns`, they are not blocking the nominal fallback chain. They are recent history from providers/models that are currently disabled or removed from the active fallback list.

If one provider/model is noisy, disable only that operation instead of removing the provider completely. For example:

```bash
LLM_MODEL_POLICY_SAMBANOVA_GPT_OSS_120B=impact_enabled=true,briefing_enabled=false
```

This keeps useful impact capacity while removing a bad briefing fallback.

## Database maintenance

The home dashboard and `/api/ops/health` expose the tables with the highest dead-row counts from `pg_stat_user_tables`. Moderate dead rows are normal in a constantly updating queue system. If the same table stays high or query latency increases, run maintenance from Postgres:

```bash
docker.exe exec signalrss-postgres-1 psql -U signalrss -d signalrss -c "VACUUM ANALYZE;"
```

## Mattermost publishing

Mattermost is downstream from duplicate checks. `mattermost-worker` should only post after:

- A briefing exists.
- The category has a configured channel.
- The priority level is allowed by `MATTERMOST_LEVELS`.
- The story was not already posted globally.
- Cross-category clearance has no unresolved duplicate candidate.

If Mattermost shows failed posts, inspect grouped errors before retrying:

```bash
docker.exe exec signalrss-postgres-1 psql -U signalrss -d signalrss -c "SELECT status, error, count(*) FROM mattermost_notifications GROUP BY status, error ORDER BY count(*) DESC LIMIT 20;"
```

If failures were external and are now resolved, retry failed rows instead of regenerating briefs or images.

## Public repository checks

Before committing, run:

```bash
npm run validate
```

This runs the test suite and scans tracked files for common API key formats, tracked `.env` files, SQL dumps, and generated thumbnails.

Run these checks when changing Docker, network fetching, request parsing, or publication logic:

```bash
npm test
npm audit --omit=dev
docker.exe compose config --quiet
git diff --check
```

## What must stay local

Do not commit:

- `.env` or `.env.*`
- API keys or webhook URLs
- Database dumps and backups
- Generated thumbnails
- Runtime logs
- Local provider experiments with real secrets

Use `.env.example` for names and safe defaults only.
