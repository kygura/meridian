# Deploying Meridian

Meridian runs as one Node process: a Hono server (`server/index.ts`) that serves the API under `/api/*` and the built frontend from `dist/`.

## Render (current target)

`render.yaml` is the blueprint. It sets up one web service with a 1 GB persistent disk mounted at `/var/data`.

- Build: `npm ci && npm run build`
- Start: `npm start`, which runs `tsx server/index.ts` under Node 22. Render's Node runtime has no Bun.
- Health check: `GET /api/health`
- Environment:
  - `DATA_DIR=/var/data`, so the journal, imports, watches, alerts and bookings survive deploys.
  - `MERIDIAN_TOKEN` gates the journal, replay, import and watches APIs. Without it they return 401.
  - `OPENAI_API_KEY` is optional. Without it the agent uses its mock path.
  - `ALERT_WEBHOOK_URL` is optional.
- Daily watch run: nothing schedules `POST /api/watches/run` yet (see `wiki/tensions.md`, T6).

## Why not Vercel

The frontend would build on Vercel, but the server keeps its state as JSON files under `DATA_DIR`. It writes them atomically and serializes the writes. Vercel functions have no persistent, writable disk, so the journal, imports, watches and bookings would be lost between invocations.

Moving to Vercel means replacing `server/lib/jsonStore.ts` with a durable store (Vercel Blob, KV or Postgres) and wrapping the Hono app as a function. Until that happens, Render is the supported target. The old frontend-only `vercel.json` was removed because it shipped the UI without its API.
