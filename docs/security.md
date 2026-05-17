# Security Notes

SignalRSS ingests untrusted RSS feeds, article metadata, thumbnails, and generated image URLs. Treat every external URL and payload as untrusted.

## Network Fetching

- All shared HTTP fetches go through `src/http-utils.js`.
- URL validation blocks non-HTTP protocols, embedded credentials, localhost, private IP ranges, link-local ranges, multicast/reserved ranges, and hostnames that resolve to blocked IPs.
- Redirects are followed manually and each redirect target is revalidated.
- RSS feed bodies are capped by `FEED_MAX_BYTES`.
- Mattermost thumbnail metadata and generated-image downloads are capped by `MATTERMOST_THUMBNAIL_METADATA_MAX_BYTES` and `MATTERMOST_THUMBNAIL_DOWNLOAD_MAX_BYTES`.

## Container Runtime

- The application image runs as the non-root `node` user.
- Long-running application services drop all Linux capabilities and set `no-new-privileges:true`.
- The API and Postgres host ports bind to `127.0.0.1` by default. Override `API_BIND_ADDRESS` or `POSTGRES_BIND_ADDRESS` only when intentionally exposing them.
- Postgres keeps its standard image runtime configuration because it manages its own database process and volume permissions.

## HTTP Responses

API, RSS, HTML, JSON, and generated thumbnail responses include security headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- A restrictive Content Security Policy suitable for the current inline UI.

## API Request Controls

- Docker binds the API to `127.0.0.1` by default through `API_BIND_ADDRESS`.
- The Node HTTP server enforces request, header, keep-alive, URL-length, and header-count limits.
- JSON request bodies require `application/json`, have a byte cap, and malformed JSON returns `400` instead of leaking an internal error.
- Write requests use a small in-memory per-client rate limit controlled by `API_WRITE_RATE_LIMIT_WINDOW_MS` and `API_WRITE_RATE_LIMIT_MAX`.
- Server errors return a generic message to clients while details stay in logs.

## Dependency Hygiene

Run these checks before shipping infrastructure or network-fetching changes:

```bash
npm test
npm audit --omit=dev
docker.exe compose config --quiet
```

The current dependency tree is expected to audit cleanly.
