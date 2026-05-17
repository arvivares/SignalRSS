# Security Policy

SignalRSS is a public, self-hosted project that processes untrusted RSS feeds and external URLs. Do not open a public issue with secrets, webhook URLs, database dumps, or private deployment details.

## Supported version

The `main` branch is the actively maintained version.

## Reporting a vulnerability

Report vulnerabilities privately to the repository owner. Include:

- A short description of the issue.
- Affected file, endpoint, or worker.
- Reproduction steps that do not expose real secrets.
- Expected impact.

## Local security checks

Before publishing changes, run:

```bash
npm run validate
npm audit --omit=dev
docker.exe compose config --quiet
```

`npm run validate` runs tests and checks tracked files for common secret formats and local artifacts that must not be committed.

## Secret handling

Keep all provider keys, webhook URLs, Langfuse keys, and database credentials in `.env` or a deployment secret manager. `.env.example` should contain only empty placeholders or safe local defaults.
