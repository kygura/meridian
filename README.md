# Meridian

A personal travel planner on a world map. Plan trips as routes between cities, see when each place is at its best, book test flights, keep a journal of past travel, and find new places that match trips you liked.

Live: https://meridian-mocha-iota.vercel.app

## What's in it

| Screen | What it does |
|---|---|
| **Map** | Flat map of ~5,900 cities matched to their airports. Click a city for scores, climate, and a neutral briefing of what's happening there, written by Claude Haiku from the headlines (no headlines printed, numbered sources at the bottom; rule-based without an Anthropic key). The briefing leads with problems detected from the country's headlines (e.g. repeated deadly rail crashes followed by fraud probes and protests reads as a rail-safety pattern; also air, roads, power, water, outbreaks, crime, strikes, corruption). Layers tint countries by comfort, temperature, rain or greenery for any month, search cities by conditions ("warm dry", "lush", "snow"), colour and filter cities by safety, quality of life, internet, cost and crowds, and mark events, conflicts, seasonal hazards and news alerts. |
| **Trips** | Planned trips as ordered city routes with flight estimates, plus past journeys from the journal. |
| **Plan › When to go** | Month-by-month comfort index per city or region, from 2015–2024 climate data. |
| **Plan › Repeat a trip** | Ranks city × month windows by how closely they match a past journey, with sliders to shift temperature, budget, crowds and month. |
| **Plan › Watches** | Saved Repeat-a-trip searches, checked daily, that alert when a match comes into booking range at a good price. |
| **Plan › Flights** | Flight search and booking in Duffel's test mode (mock offers without a key). Nothing is really ticketed. |
| **Inbox** | Review queue for imports (past bookings, photo locations, Google location history, booking emails) before they become journal entries. Photos never leave the device; only time, place and a hash are sent. |
| **World** | Travel news and country stats by region. |
| **Ask** | Research assistant that searches places, pulls images and checks seasonality. Runs on Claude (pick Opus 5.5, Sonnet 5.5 or Haiku 5.5 in the panel) with an Anthropic key, or a deterministic mock without one. |

`CONTEXT.md` defines the terms used throughout the code (Trip vs Journey, Leg vs Segment, Window, Watch, and so on).

## Stack

- **Frontend:** React 19, Vite 6, TypeScript, Zustand, MapLibre GL. Hand-written CSS.
- **Server:** Hono on Node 22 (`tsx`), zod validation.
- **Storage:** one document store with two backends: JSON files under `DATA_DIR`, or Postgres when `DATABASE_URL` is set (ADR 0006).
- **External services, all optional:** Anthropic Claude (assistant and news briefing), Duffel and SerpAPI (flight prices), Open-Meteo (climate), Wikipedia/Wikimedia (images), Google News search RSS (city and country headlines; Google allows personal, non-commercial use of these feeds).
- **Tests:** Vitest.

## Run it locally

```sh
npm ci
cp .env.example .env        # everything in it is optional for local use
npm run dev:all             # app on http://localhost:5173, API on :3001
```

Without any keys the app runs fully on mock data, clearly labelled. Personal data goes to `data/` as JSON files.

To unlock the journal, trips sync, Repeat a trip and Watches, set `MERIDIAN_TOKEN` in `.env` and paste the same value into **Settings › Journal**.

## Scripts

| Command | Does |
|---|---|
| `npm run dev:all` | Vite and the API server together, with reload |
| `npm start` | API server, serving the built frontend from `dist/` |
| `npm run build` | Typecheck and build the frontend |
| `npm run build:vercel` | `build`, then write Vercel's Build Output API to `.vercel/output` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. Set `TEST_DATABASE_URL` to also run the Postgres tests against a scratch database |
| `npm run build:data` | Rebuild `data/airports.json` (needs Bun) |
| `npm run build:seasonality` | Rebuild `data/seasonality.json` from Open-Meteo (needs Bun) |

## Configuration

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Postgres for personal data. Required on hosts without a persistent disk (Vercel) |
| `DATA_DIR` | Where JSON files and caches go when there's no database. Default `./data` |
| `MERIDIAN_TOKEN` | Password for the journal, trips sync, Repeat a trip, imports and watches. Unset means those stay locked |
| `CRON_SECRET` | Vercel only. Same value as `MERIDIAN_TOKEN`, so the daily watch run passes the gate |
| `ANTHROPIC_API_KEY` | Claude for Ask, city research and the news briefing, instead of the mock and rule-based paths |
| `AGENT_MODEL` | Default Claude model for Ask and research (`claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`). Default `claude-opus-5-5` |
| `NEWS_BRIEF_MODEL` | Model for the city news briefing. Default `claude-haiku-5-5` |
| `DUFFEL_API_KEY`, `SERPAPI_KEY` | Real flight offers and prices instead of mock ones |
| `ALERT_WEBHOOK_URL` | Where watch alerts are POSTed |
| `VITE_API_BASE_URL` | Only if the frontend is served separately from the API |

## Deploying

Production runs on Vercel with Supabase Postgres. Any Node host works too (Render, Railway, Fly.io, a VPS). See `docs/DEPLOY.md` for the steps for each, and `scripts/copy-data-to-postgres.ts` for moving file data into a database.

## Repository layout

```
src/            React app: screens/, shell/ (layout, nav), ui/ (components), lib/ (client logic)
server/         Hono API: app.ts (routes), index.ts (Node server), vercel.ts (Vercel function)
  routes/       one file per /api/* area
  lib/          domain logic, storage (jsonStore.ts, pgDocuments.ts), agent tools
scripts/        dataset builders, Vercel build, data copy to Postgres
data/           read-only datasets (cities, airports, seasonality, events, phenomena)
plans/          trip plans as importable files (Settings › Trips › Import)
docs/
  adr/          architecture decisions, numbered
  design/       UI and feature design briefs
  specs/        build specs and task logs, kept for history
  DEPLOY.md     hosting
```

## Known gaps

Open decisions carried over from the old wiki:

- **Bookings have no auth.** `/api/bookings` holds passenger details and isn't behind `MERIDIAN_TOKEN` yet, so anyone with the URL can read them. Bookings are test-mode only, but they should be gated before real use.
- **Seasonality covers 120 cities up front.** Others are fetched on demand when they show up. There's no nightly backfill.
- **Crowds is a proxy** built from climate peaks and holidays, not real visitor data.
- **Repeat a trip works by month**, not by week.
