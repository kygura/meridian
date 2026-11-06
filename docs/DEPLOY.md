# Deploying Meridian

Meridian runs as one Node process: a Hono server (`server/index.ts`) that serves the API under `/api/*` and the built frontend from `dist/`.

## Where data lives

Personal data (journal, imports, watches, alerts, bookings, shortlist, trips) goes through one store with two backends (ADR 0006):

- **Files** (default): JSON under `DATA_DIR`. Needs a persistent disk.
- **Postgres**: set `DATABASE_URL` and everything is stored in one `meridian_documents` table, created on first use. Any Postgres works (Neon, Supabase, Railway, RDS, your own). The host then needs no disk.

So Meridian runs on any host that can run `npm start` under Node 22: Render, Railway, Fly.io, a VPS, or a container. Set `DATABASE_URL` wherever there is no persistent disk.

To move existing data from a disk into Postgres:

```sh
DATA_DIR=/var/data DATABASE_URL=postgres://… npx tsx scripts/copy-data-to-postgres.ts
```

It keeps documents already in the database unless you pass `--overwrite`.

## Any Node host

- Build: `npm ci && npm run build`
- Start: `npm start`
- Health check: `GET /api/health`
- Environment: `DATABASE_URL` (or `DATA_DIR` on a persistent disk), `MERIDIAN_TOKEN`, and the optional keys in `.env.example`.

## Render

`render.yaml` is a ready blueprint. It sets up one web service with a 1 GB persistent disk mounted at `/var/data`.

- Build: `npm ci && npm run build`
- Start: `npm start`, which runs `tsx server/index.ts` under Node 22. Render's Node runtime has no Bun.
- Health check: `GET /api/health`
- Environment:
  - `DATA_DIR=/var/data`, so personal data survives deploys. Set `DATABASE_URL` instead to drop the disk.
  - `MERIDIAN_TOKEN` gates the journal, replay, import, watches and trips APIs. Without it they return 401, and trips stay in each browser.
  - `OPENAI_API_KEY` is optional. Without it the agent uses its mock path.
  - `ALERT_WEBHOOK_URL` is optional.
- Daily watch run: nothing schedules `POST /api/watches/run` yet (see `wiki/tensions.md`, T6).

## Vercel

With `DATABASE_URL` set, storage is no longer the blocker. What remains is wrapping the Hono app as a function (it currently starts a long-running server) and moving the few disk caches (images, news, crowd data) to `/tmp` or dropping them. Until that's done, use a host that runs `npm start`.
