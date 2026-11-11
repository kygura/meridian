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
- Set `NODE_ENV=production` (Render and Vercel do this themselves). It makes the session cookie `Secure`, adds HSTS, and stops accepting requests from `localhost` dev origins. Serve it over HTTPS.
- Behind a reverse proxy, set `TRUST_PROXY` to the number of proxies in front, so rate limits and the sign-in lockout see each visitor's address instead of the proxy's.

## Render

`render.yaml` is a ready blueprint. It sets up one web service with a 1 GB persistent disk mounted at `/var/data`.

- Build: `npm ci && npm run build`
- Start: `npm start`, which runs `tsx server/index.ts` under Node 22. Render's Node runtime has no Bun.
- Health check: `GET /api/health`
- Environment:
  - `DATA_DIR=/var/data`, so personal data survives deploys. Set `DATABASE_URL` instead to drop the disk.
  - `MERIDIAN_TOKEN` is the owner's password. It gates the journal, replay, import, watches, trips and bookings APIs. Without it they return 401, and trips stay in each browser.
  - `TRUST_PROXY=1` (set in `render.yaml`) tells the server one proxy sits in front, so rate limits and the sign-in lockout count per visitor rather than for everyone together. Not verified against Render's current proxy chain: if the lockout seems to hit everyone at once, the hop count is wrong, and unsetting it is the safe fallback (ADR 0009).
  - `ANTHROPIC_API_KEY` is optional. Without it Ask uses its mock path and the city news briefing is rule-based.
  - `ALERT_WEBHOOK_URL` is optional.
- Daily jobs (the watch run and anything registered with `registerDailyJob`): the server runs them itself at 06:17 UTC (`DAILY_JOBS_AT`), including after a restart or a free-tier sleep, so no Cron Job is needed. Set `DAILY_JOBS=off` if you drive `GET /api/jobs/daily` from an external cron instead. On Vercel the cron does it (see below). Instances that share a Postgres run the day once.

## Vercel

`vercel.json` sets the install command (`npm ci`) and build command (`npm run build:vercel`). The build writes Vercel's Build Output API directly (`scripts/build-vercel.mjs`):

- the Vite build as static files, with every non-API path falling back to `index.html`;
- one Node 22 function (`api.func`) holding the whole Hono server, bundled with esbuild, with the read-only datasets (cities, airports, seasonality) beside it. `/api/*` routes to it. Max duration 60 s;
- a daily cron (06:17 UTC) that calls `GET /api/jobs/daily` (the watch run and any other daily job).

On Vercel only `/tmp` is writable, so caches go to `/tmp/meridian` and rebuild on a cold start. Personal data must be in Postgres: **`DATABASE_URL` is required on Vercel.** Without it, writes land in `/tmp` and disappear.

### Steps

1. **Database.** Create a Postgres database (Supabase or Neon both have free tiers). Copy its connection string. On Supabase, use the pooled "Transaction" connection (port 6543), since serverless functions open many short connections.
2. **Project.** In Vercel, import the GitHub repo. Leave the framework as "Other"; `vercel.json` supplies the commands.
3. **Environment variables** (Production and Preview):
   - `DATABASE_URL`: the connection string from step 1. Mark it Sensitive.
   - `MERIDIAN_TOKEN`: a long random string, e.g. `openssl rand -hex 32`. This is the password you sign in with under Settings › Account.
   - `CRON_SECRET`: another random string. Vercel Cron sends it as a bearer token, and the gate accepts it for `GET /api/jobs/daily` and `GET /api/watches/run` only. (The same value as `MERIDIAN_TOKEN` still works.)
   - Optional: `SESSION_SECRET`, a third random string that signs the session cookie. Without it the key is derived from `MERIDIAN_TOKEN`.
   - Optional: `ANTHROPIC_API_KEY`, `DUFFEL_API_KEY`, `SERPAPI_KEY`, `ALERT_WEBHOOK_URL`.
4. **Deploy.** Push, or redeploy from the dashboard. Check `https://<your-app>/api/health`.
5. **Move existing data** (only if you had data on a disk):
   `DATA_DIR=/path/to/data DATABASE_URL=… npx tsx scripts/copy-data-to-postgres.ts`
6. **Sign in** on each device: Settings › Account, enter `MERIDIAN_TOKEN`. The browser keeps a 30-day session cookie, not the password. Trips then sync.

Cron jobs run on Production deployments only. Preview deployments sit behind Vercel Authentication by default.

To check a build locally: `npm run build:vercel`, then look in `.vercel/output`.
