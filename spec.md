# Meridian — Build Specification

**Date:** 2026-07-09 · **Baseline commit:** `f9f3a25` · **Branch:** `master`

## 1. What Meridian is today

Meridian is a single-user travel-intelligence app: an interactive MapLibre GL globe
(cartographic "parchment dispatch" aesthetic, day/night themes) over a city database
(~4,661 cities from worldcities.csv, matched to ~29k airports), with:

- **Frontend:** React 19 + Vite 6 + TypeScript, Zustand (single store, localStorage
  persistence for trips only), hand-written CSS in `src/index.css` (Tailwind wired but
  barely used), hash routing (`#/` globe, `#/trips[/:id]`).
- **Backend:** Hono on Bun (`server/index.ts`, port 3001), flat-file JSON storage
  (`data/`, relocatable via `DATA_DIR`). Routes: `/api/cities`, `/api/metrics`,
  `/api/agent/*`, `/api/shortlist`, `/api/news`, `/api/health`.
- **AI:** Vercel AI SDK v4 + `@ai-sdk/openai` (`gpt-4o-mini`). The current "agent" is a
  set of one-shot prompt endpoints (`research`, `trip-options`, `chat`, `ticker`) — no
  tool-calling, no multi-step loop. Every AI path degrades to a deterministic mock when
  `OPENAI_API_KEY` is absent.
- **Flights:** Duffel v2 provider (offer search only, no orders) with SerpAPI
  google_flights fallback, orchestrated by `server/lib/flightSearch.ts`. No keys → mock
  estimates.
- **Trips:** client-side only (Zustand persist → localStorage). Legs are city nodes with
  no dates. "Booking" today means external deep links to Google Flights / Booking.com.
- **Scoring:** largely synthetic — deterministic hash pseudo-scores for 4 of 5
  sub-scores; the seasonality chart in `MetricPanels.tsx` is client-side `Math.random()`
  noise.

Known debt relevant to this build: `ChatPanel.tsx` is orphaned (CommandPalette has its
own `useChat`), trip pricing beyond the first leg stays mock even with keys, and there
is no server-side trip/booking persistence.

## 2. Ambitions of this build

Three pillars, from the user's request:

1. **E2E booking pipeline** — create end-to-end trips with flights, booked for real
   against Duffel in **test mode only**.
2. **Seasonality heatmap calendar** — a calendar-style heatmap showing the best time to
   visit per destination/region, backed by real climate data (replacing the random-noise
   chart).
3. **Agentic loop rewrite** — replace the one-shot prompt endpoints with a real
   tool-calling agent loop that researches places, enriches them with images, and
   surfaces them in a dedicated "open places" tab/modal.

## 3. Assumptions (clarifying gate — resolved autonomously)

The interactive clarifying gate was unavailable in this run; these calls were made via
an architecture-review pass and are recorded here as binding assumptions:

- **A1 — Bookings are server-side, self-contained aggregates; trips stay client-side.**
  A booking snapshots its leg (origin/destination/dates/passengers/offer terms) plus the
  Duffel order. It references `tripId`/`legIndex` but does not require a server-side
  trip row. Trip migration to the server is explicitly out of scope. (ADR 0001)
- **A2 — Offers are ephemeral; orders are durable.** Duffel offers expire in minutes.
  The booking flow re-searches on checkout entry and books from a live offer in one
  session. Offers are never persisted as a resting state; only created orders persist.
- **A3 — Seasonality is precomputed offline** from Open-Meteo ERA5 monthly historical
  data averaged over a multi-year window, stored as compact per-city monthly scores
  (committed JSON, target well under 1 MB), served by the API. No runtime climate
  fetching. The metric is labeled a "comfort index", not universal truth. (ADR 0002)
- **A4 — Shared tool core.** Agent capabilities (`search_places`, `get_place_images`,
  `get_seasonality`, `get_flight_estimate`) are plain functions. The LLM loop wraps them
  as AI SDK tools; the mock path (no `OPENAI_API_KEY`) calls the same functions
  deterministically; legacy endpoints (`/api/agent/research`, `/api/agent/trip-options`)
  become thin wrappers over the same core so `AgentBrief.tsx` keeps working unchanged.
  (ADR 0003)
- **A5 — Keys.** `OPENAI_API_KEY` is present locally → real agent loop is exercised.
  `DUFFEL_API_KEY` and `SERPAPI_KEY` are absent → the booking pipeline runs against
  clearly-labeled mock offers locally; this is a reported blocker-note for live-sandbox
  verification, not a build stopper. Live (non-test) Duffel payment is out of scope
  permanently. No credentials are ever hardcoded.
- **A6 — Place images** come from the Wikipedia/Wikimedia APIs (no key required), cached
  on disk server-side. Unsplash is not integrated (needs a key).
- **A7 — `ChatPanel.tsx` is deleted**, not migrated. The rewritten agent UI replaces it;
  CommandPalette keeps consuming the same `/api/agent/chat` contract.

## 4. Scope

### 4.1 Booking pipeline (server + UI)

**Server** (`server/routes/bookings.ts`, `server/lib/booking.ts`):

- `POST /api/bookings/search` — body `{originIata, destinationIata, departureDate,
  returnDate?, passengers}` → live Duffel offer search (test key) or labeled mock offers
  (`source: "mock"`) when no key. Returns offers with id, price, currency, segments,
  carrier, duration, `expiresAt`, `source`.
- `POST /api/bookings` — body `{offerId, tripId?, legIndex?, passengers: [{givenName,
  familyName, bornOn, gender, title, email, phoneNumber}]}` → creates a Duffel order
  (balance payment, test mode) or a mock order. Persists the booking aggregate to
  `data/bookings.json` (same flat-file pattern as shortlist). Returns
  `{booking}` with `status: "booked"`, `bookingReference`, order snapshot.
- `GET /api/bookings` / `GET /api/bookings/:id` — list/fetch persisted bookings.
- `DELETE /api/bookings/:id` — cancel: calls Duffel order cancellation in test mode when
  real, marks mock bookings cancelled. Status → `"cancelled"`.
- Expired-offer errors from Duffel map to a structured 409 telling the client to
  re-search. All request bodies validated with zod.

**UI** (per DESIGN-booking.md, which must exist before implementation):

- From a trip leg (TripsPage) or an agent-surfaced place: "Book flight" entry point →
  checkout flow: search results (offers with price/duration/carrier, mock badge when
  mock) → passenger details form → confirm → booked state with booking reference.
- Booked legs show a booking badge; a bookings list is reachable from the Trips page.
- The flow never claims real ticketing: test/mock provenance is always visible.

### 4.2 Seasonality heatmap calendar

**Data** (`scripts/build-seasonality.mjs`, committed output `data/seasonality.json`):

- Offline Bun script fetches Open-Meteo monthly historical aggregates (multi-year
  window) for all ~4,661 cities, computes a 0–100 monthly comfort score (temperature
  comfort band + precipitation penalty), stores only scores plus the small tooltip
  fields (mean temp °C, precip mm) per month per city. Resumable and rate-limit-polite.
  If the full run is too slow for the build, ship the committed dataset for the top ~500
  cities by population plus all capitals/hubs, with the script able to extend coverage.

**Server** (`server/routes/seasonality.ts`):

- `GET /api/seasonality/:cityId` — 12 monthly entries `{month, score, tempC, precipMm}`.
- `GET /api/seasonality?cityIds=a,b,c` — batch fetch for the calendar grid.
- `GET /api/seasonality/regions` — per-region (continent/subregion) monthly aggregates.

**UI** (per DESIGN-heatmap.md):

- A heatmap calendar surface: rows = destinations (shortlist, trip cities, or region
  aggregates), columns = 12 months, cells colored by comfort score, with tooltip
  detail and "best window" highlight. Reachable via nav; also replaces the fake
  seasonality sparkline in `MetricPanels.tsx` with real per-city data.

### 4.3 Agentic loop rewrite

**Server** (`server/lib/agent/` core + rewritten `server/routes/agent.ts`):

- Tool core as plain functions with zod-validated params: `searchPlaces` (city DB +
  scores), `getPlaceImages` (Wikipedia summary/Commons, disk-cached), `getSeasonality`
  (dataset lookup), `getFlightEstimate` (existing flightSearch).
- `POST /api/agent/chat` rewritten: AI SDK v4 `streamText` with those tools,
  `maxSteps` ≈ 6, streamed via the data-stream protocol so `useChat` consumers get
  `toolInvocations` with results. Mock path (no key): deterministic tool execution over
  the same functions, same stream format.
- Legacy `/api/agent/research` and `/api/agent/trip-options` remain, refactored to thin
  wrappers over the tool core — `AgentBrief.tsx` contract unchanged.

**UI** (per DESIGN-agent-places.md):

- New AgentPanel replacing the orphaned ChatPanel: chat with visible tool activity
  (searching, fetching images), places surfaced by tools accumulate as "open places".
- Dedicated open-places tab/modal: image, seasonality mini-strip, score summary,
  actions (fly-to on globe, add to shortlist, add to trip, book flight).
- CommandPalette keeps working against the same chat endpoint throughout.

### 4.4 Out of scope

Server-side trips, live payments, user accounts/auth, Duffel Stays, replacing the
synthetic scoring engine (beyond seasonality), Vercel serverless adapter, deck.gl
migration.

## 5. Core user flows

1. **Book a flight:** open a trip → pick a leg → Book flight → see live/mock offers →
   enter passenger details → confirm → booking reference stored and badged on the leg.
2. **Find the best time:** open Seasonality → see shortlisted destinations × 12 months
   heatmap → hover for temp/precip detail → spot the best window.
3. **Agent research:** ask the agent "warm cheap places in November with good beaches" →
   watch it search places, pull images, check seasonality → surfaced places open in the
   places tab → add one to shortlist → book from there.

## 6. Stack decisions

Existing stack extended in place: Bun + Hono + zod (server), React 19 + Zustand +
hand-written CSS matching the parchment/dispatch visual language (client), Vercel AI
SDK v4 + `@ai-sdk/openai` `gpt-4o-mini` (agent), Duffel v2 REST via fetch (booking,
test mode), Open-Meteo (seasonality, offline precompute), Wikipedia/Wikimedia (images,
no key), vitest (tests), flat-file JSON under `data/` (persistence). No new runtime
dependencies expected; no databases.

## 7. Definition of done (observable)

- `bun install && bun run typecheck && bun run test` — green (vitest suite includes new
  tests for booking state transitions, seasonality scoring, agent tool core).
- `bun run build` — production build succeeds.
- `bun run dev:all` — app serves at `http://localhost:5173` (API on 3001):
  - `POST /api/bookings/search` returns offers (mock-labeled without `DUFFEL_API_KEY`);
    `POST /api/bookings` creates and persists a booking; `GET /api/bookings` lists it.
  - `GET /api/seasonality/:cityId` returns 12 real monthly entries for covered cities.
  - `POST /api/agent/chat` streams a tool-using conversation (real with
    `OPENAI_API_KEY`, deterministic mock without); `/api/agent/research` and
    `/api/agent/trip-options` still answer with their existing shapes.
  - UI: booking checkout completes end-to-end from a trip leg; the seasonality heatmap
    renders with real data; the agent panel surfaces places with images into the
    open-places tab; existing globe, trips, command palette flows still work.
- No secrets in the repo; Duffel is test-mode only by construction.
