# Docker (planned)

> **Status:** Docker support is **not yet implemented**. No `Dockerfile`, `docker-compose.yml`, or `compose.yaml` exists in the repository. This page documents the intended approach so it can be implemented consistently later.

## Why it is deferred

The repository currently documents dependencies and versions precisely (Node >= 24 < 25, pnpm 11, PostgreSQL), and the local workflow is fully supported without Docker. Adding container configuration before the tooling to validate it is available (a Docker daemon) is deferred to avoid shipping unvalidated files.

## Intended development flow

```bash
docker compose up
```

Planned services:

| Service | Purpose | Port |
| --- | --- | --- |
| `db` | PostgreSQL | 5432 (host-mapped for tooling) |
| `api` | Fastify API | 3000 |
| `web` | Vite dev server | 5173 |

Planned behavior:

- a named volume persists PostgreSQL data across `docker compose down`;
- the API service runs `prisma migrate deploy` before starting;
- the bootstrap administrator runs interactively: `docker compose exec api pnpm bootstrap:admin`;
- health checks use the existing `GET /health` endpoint.

## Intended production flow

- A multi-stage Dockerfile for the API (install → build → `node dist/server.js`) and a static build for the web app.
- PostgreSQL in a separate service with a named volume.
- A reverse proxy terminating HTTPS in front of the web assets and proxying the API and (future) WebSocket upgrades.
- Environment variables injected at runtime (never baked into images), with `SESSION_SECRET` generated externally.

## Commands to document once implemented

- `docker compose up -d` / `docker compose down` / `docker compose down -v` (development reset)
- `docker compose logs -f`
- `docker compose exec api pnpm bootstrap:admin`
- `docker compose exec api pnpm db:migrate`

Do not treat these commands as available today.