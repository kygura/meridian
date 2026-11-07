# Meridian — Journal & Replay Spec

**Date:** 2026-10-27 · **Baseline commit:** `f82c64c` · **Builds on:** `spec.md` (2026-07-09)

> The canonical type contract for this build lives in `src/types.ts` (section
> "Journal & Replay"). Where this document and `src/types.ts` differ in a detail,
> `src/types.ts` wins. Planner rulings made during the build are in §14 at the end.

## 1. Why this build

Meridian today looks forward. It covers where to go, when the climate is good, and how to book a flight.
It has no memory of where the user has already been. This build adds that memory, and
then uses it as the input to planning:

> "Find me another window like Lisbon, May 2024 — a bit warmer, cheaper, fewer crowds."

Past journeys become templates for future trips. Four pillars:

1. **Journal**: log every past journey (stops, flights and other segments, stays,
   experiences, spend, ratings, notes) and see it on the globe and on a timeline.
2. **Fingerprint & Replay**: stamp each journey with the conditions actually met
   (observed weather, spend, crowd proxy, season), then rank other destination × month
   windows by similarity, bent by user sliders.
3. **Ingestion**: fill the journal mostly automatically from booking emails, calendar,
   location history and photo metadata, through a review queue. Hand entry is kept for ratings and notes.
4. **Watches**: saved replay queries that alert when a top-matching window comes into
   booking range at a price below what the user historically pays.

## 2. What already exists and gets reused

| Existing piece | Where | Reused for |
|---|---|---|
| City DB + IATA match (`cityId` as universal key) | `server/lib/cities.ts` | Every journey stop resolves to a `cityId` |
| Comfort Index formula + daily→monthly aggregation | `server/lib/seasonality.ts` (`comfortScore`, `aggregateDailyToMonthly`) | Observed-conditions scoring for logged stops |
| On-demand Open-Meteo archive fetch, in-flight dedupe, quota → unavailable | `server/lib/seasonality.ts` (`resolveCitySeasonality`) | Fetch actual weather for a journey's date range |
| Seasonality heatmap components | `src/components/seasonality/*` | Replay match grid (same grid, match score instead of comfort) |
| Booking aggregate (`data/bookings.json`) | `server/lib/booking.ts` | Past bookings promote into journey segments |
| Flight estimate orchestration (Duffel → SerpAPI → mock, `dealRating`) | `server/lib/flightSearch.ts` | Price stage of replay; watch price checks |
| Agent tool core (ADR 0003) | `server/lib/agent/tools.ts` | New journal/replay tools, same mock-path guarantee |
| Great-circle routes, trip colors | `src/lib/geo.ts`, `src/lib/tripColors.ts`, `Globe.tsx` | Journey arcs layer |
| Client Trips + booking flow | `src/store.ts`, `TripsPage.tsx`, `components/booking/*` | "Repeat this journey" → new Trip → book |
| Flat-file JSON under `DATA_DIR` | `server/lib/paths.ts` | Journal, imports, watches, alerts storage |

What must **not** be reused as a signal: `scoring.ts` economics/quality/stability and
`datasets.ts` tourism/cost surfaces. They are deterministic hash noise (`source:
"synthesized"`), so feeding them into a "match my past trip" engine would produce
confident nonsense. Replay uses only real or user-recorded data, and labels proxies as
proxies.

## 3. Decisions (binding for this build)

- **D1: Journal is server-side, single-user, token-gated.** (ADR 0004) Journeys are
  durable personal history that ingestion jobs write from outside the browser, so they
  live in `data/journal.json`, not localStorage. The deployed Render instance is public
  and has no auth today. All new routes (`/api/journal*`, `/api/replay*`,
  `/api/watches*`, `/api/import*`) require `Authorization: Bearer $MERIDIAN_TOKEN`. The
  same middleware should cover `/api/bookings*`, which already stores passenger PII
  unauthenticated (tracked as tension T1, not silently changed).
- **D2: Journey is distinct from Trip.** A Trip is a client-side plan (ADR 0001
  unchanged). A Journey is something that happened. A Journey can be created from a Trip
  plus its Bookings ("promote"), and a Trip can be created from a Journey ("repeat"), but
  neither owns the other. CONTEXT.md is updated: "journey" leaves Trip's avoid-list and
  becomes its own term.
- **D3: Replay is deterministic; the LLM is an interface, not the engine.** (ADR 0005)
  Fingerprinting and similarity ranking are pure functions with tests. The agent gets
  tools that call them. Replay works fully with no LLM key.
- **D4: LLM-heavy ingestion runs outside the app.** Parsing years of booking emails is
  the most token-hungry job in the system. It runs as a scheduled Claude task using the
  Gmail and Calendar connectors, which POSTs normalized records to Meridian's import
  endpoint. This keeps the bulk work on the subscription instead of a metered API key,
  and avoids the OpenAI `insufficient_quota` blocker logged in `TASKS.md`. An in-repo
  deterministic parser (schema.org JSON-LD) handles the structured majority of emails
  with no LLM at all.
- **D5: Granularity is monthly in v1.** The seasonality dataset is monthly normals.
  Replay cells are destination × month. Weekly resolution needs a weekly dataset and is
  a later extension, not faked by interpolation.
- **D6: Imports land as drafts.** Nothing from ingestion becomes a confirmed journey
  without passing the review queue. Every record carries provenance (`source`,
  `sourceRef`, `confidence`), following the existing mock/test provenance pattern in
  booking.
- **D7: Money is normalized at record time.** Every amount stores original currency +
  amount, plus an EUR value converted at the ECB rate for that date (Frankfurter API,
  keyless, cached). Comparisons always use the normalized value.

## 4. Data model

Types live in `src/types.ts` (shared by client and server). See that file for the
exact shapes: `Provenance`, `Money`, `Journey`, `JourneyInput`, `Stop`, `Lodging`,
`Segment`, `Experience`, `ObservedConditions`, `Fingerprint`, `ReplayQuery`,
`ReplayResult`, `ReplayResponse`, `ImportCandidate`, `ImportCluster`, `ImportQueue`,
`ImportReport`, `Watch`, `Alert`, `MeridianEvent`, `JournalSettings`.

Storage: `data/journal.json` → `{ version, journeys: Journey[] }`, written atomically
(temp file + rename). `data/imports.json` holds the review queue (§7). Home base is a
single setting, `data/settings.json → { homeCityId }`, used for flight-cost baselines.
Watches in `data/watches.json`, alerts in `data/alerts.json`. Caches (FX rates,
Nager.Date holidays, observed weather) under `data/cache/` (gitignored).

## 5. Fingerprint

A fingerprint is a small vector computed per journey (and per stop), stored on the
record, and recomputed when the journey or its inputs change.

| Dimension | Source | Notes |
|---|---|---|
| `month` (+ week-of-year kept for later) | stop dates | Circular: Dec is next to Jan |
| `comfort`, `tempC`, `precipMm` | Open-Meteo archive for the exact stay dates, scored with the existing `comfortScore` | Reuses the existing fetch path. Quota miss → dimension marked pending, retried, never guessed |
| `dailySpendEur` | sum of stop lodging + experiences ÷ nights ÷ companions | Only from recorded money. Absent → dimension absent, not zero |
| `flightCostEurPer1000km` | segments with cost, distance via `haversineKm` | Lets a cheap short hop and a long-haul compare fairly |
| `crowdProxy` (0–100) | see below | Always labeled "proxy" in UI |
| `durationNights` | dates | Used for filtering, not similarity |
| `rating`, `tags` | user | Rating weights which past journeys count as good templates |

**Crowd proxy (v1):** there is no free, reliable, global crowd dataset. v1 combines
(a) a month-relative peak index from the city's own comfort curve (tourist seasons track
comfort seasons in most leisure destinations), and (b) public/school holiday overlap in
the top source markets from Nager.Date (keyless). The user can override it per stop
("it was packed"), and that override wins. The synthetic `tourism` surface is not used.

Missing dimensions are dropped from the similarity calculation for that pair and the
weights renormalized. Each result reports which dimensions it was scored on.

## 6. Replay

### 6.1 Query

See `ReplayQuery` in `src/types.ts`. Bend = slider offsets applied to the template
before matching (tempC −10..+10, spendPct −50..+50, crowd −50..+50, monthShift −6..+6 or
null = any month). Weights `{climate, spend, crowd, flight}` each 0..1. Constraints:
months, regions, excludeVisited, maxFlightHours, fromCityId (defaults to home), event tags.
`limit` default 30.

### 6.2 Ranking (two stages)

1. **Climate/season stage (cheap, all covered cities × 12 months).** For every city in
   the seasonality cache and every month, compute weighted distance from the bent
   template on comfort, temp, precip and crowd proxy. Keep the top ~60. This stage runs over
   the seasonality cache only, so its universe is the cache (120 cities today) plus any
   city surfaced on demand. The response reports the universe size so a thin result is
   explainable.
2. **Price stage (expensive, top N only).** For the top ~20 survivors, get a flight
   estimate from `fromCityId` for a representative date in that month via the existing
   `getFlightEstimate`. Compare to the user's own baseline: median
   `flightCostEurPer1000km` across confirmed journeys, falling back to SerpAPI's
   `dealRating`. Daily spend uses the user's recorded spend in that city or country when
   it exists, and is otherwise absent. Mock-sourced prices are shown with the mock badge
   and excluded from the spend dimension, matching how booking already labels mock.

Output per result: see `ReplayResult`.

### 6.3 Endpoints

- `POST /api/replay` → `ReplayResponse` (body = `ReplayQuery`, zod-validated).
- `GET /api/journal/:id/fingerprint` → fingerprint, with per-dimension status
  (`ok` / `pending` / `absent`).

### 6.4 Repeat

Client-side: "Repeat" on a journey or a replay result creates a Trip in the
existing store (`createTrip` + `addCityToTrip`) with nodes from the stops (or the single
matched city). The booking flow then works unchanged.

## 7. Ingestion

All paths produce `ImportCandidate` records into the review queue. None write journeys directly.

**Server:**
- `POST /api/import` accepts `ImportCandidate[]` (token-gated, max 500 per call).
  Dedupe on `(source, sourceRef)`, and for segments also on `(carrier+number, departDate)`.
- **Clustering:** pending candidates are grouped into suggested journeys by date
  proximity (gap ≤ 2 days between consecutive items, with home-city segments as
  boundaries). City resolution: IATA → `cityId` via the airport match, else name
  search via the existing cities lookup. Unresolved → `confidence: low`, flagged in
  review.
- `GET /api/import/queue`, `POST /api/import/:id/{accept|merge|discard}`, and
  `POST /api/import/cluster/:clusterId/accept` (accept a whole suggested journey).

**Sources, in build order:**
1. **Meridian bookings.** Any `booked` Booking whose departure date has passed becomes a
   candidate automatically (`source: "booking"`, `confidence: high`).
2. **Email file upload, deterministic.** Upload `.eml` or a Google Takeout `.mbox`. The
   server extracts schema.org JSON-LD (`FlightReservation`, `LodgingReservation`,
   `EventReservation`, `TrainReservation`, `RentalCarReservation`). No LLM,
   `source: "jsonld"`. Emails without markup are counted and reported, not guessed at.
3. **Scheduled Claude task (Gmail + Calendar connectors).** A stored prompt at
   `docs/ingest/gmail-import-task.md` defines the Gmail search queries, the extraction
   schema (= `ImportCandidate`) and the POST to `/api/import`. One-time backfill, then
   weekly. `source: "gmail"` / `"calendar"`. Requires the deployed instance URL and
   `MERIDIAN_TOKEN`.
4. **Location history.** Upload the on-device Google Maps Timeline export (JSON). Visits
   ≥ 1 night away from home become `stop` candidates. Parsed server-side; the raw file
   is not stored.
5. **Photos.** Client-side EXIF read (`exifr`) of a selected folder. Only
   `{timestamp, lat, lng, hash}` leave the browser, never images. These cluster into stop
   and experience candidates.

**UI, review queue** (`#/journal/inbox`): suggested journeys as cards with their
candidates, low-confidence items flagged, and one-click accept / merge into an existing
journey / discard. Count badge in TopBar.

## 8. UI

New routes `#/journal`, `#/journal/:id`, `#/journal/inbox`, `#/journal/replay`, plus a
JOURNAL nav item next to SEASONS.

- **Timeline** (`#/journal`): journeys grouped by year. Header stats: countries, cities,
  nights away, km flown, total spend (EUR). Filter by tag, rating, year.
- **Journey detail** (`#/journal/:id`): stops with dates, segments, lodging, experiences
  and spend. A fingerprint panel shows observed vs. normal comfort ("you got a warmer
  week than usual"), with per-dimension status. Actions: edit, **Find similar** (opens
  Replay pre-filled), **Repeat** (§6.4).
- **Quick log**: a form for a manual journey, plus "log from globe" (click cities in
  order, then set dates).
- **Replay** (`#/journal/replay`): sliders for temperature, spend, crowds and month shift,
  plus weight sliders. The result grid reuses `HeatmapGrid` / `HeatRow` / `HeatCell` with
  rows = matched cities and columns = months, cells colored by match score, and the
  template's own month outlined. Tooltip shows the per-dimension breakdown and price
  provenance. Right column: ranked list with "Repeat" and "Watch".
- **Globe journeys layer**: `LayerKey` `"journeys"`. Past segments are drawn as
  great-circle arcs, visually distinct from planned trip routes (muted ink, thinner,
  dashed for non-flight modes). A **time scrubber** in the layer control has two modes:
  *chronological* (arcs appear year by year) and *seasonal* (all years folded onto 12
  months: "where am I usually in March").

Styles go in `src/styles/journal.css`, using tokens from `index.css`.

## 9. Agent tools (extends ADR 0003)

New tool functions in `server/lib/agent/journal-tools.ts`. They never throw, have zod
params, and work identically on the mock path:

- `search_journal({ text?, cityId?, country?, year?, month?, tags?, minRating? })` → journey summaries
- `get_fingerprint({ journeyId, stopIndex? })`
- `find_similar_windows(ReplayQuery)` → stage-1 + stage-2 results
- `draft_journey({ ... })` → creates an `ImportCandidate` cluster (`source: "manual"`). The
  agent cannot confirm journeys; the user does in the inbox.

Example the loop must handle: "somewhere like Lisbon last May but warmer and cheaper,
in spring" → `search_journal` → `find_similar_windows` with bend `{tempC:+3,
spendPct:-25}` and months `[3,4,5]` → results surface as Open Places (existing A2
concept), each with a match breakdown.

## 10. Watches

See `Watch` and `Alert` in `src/types.ts`.

- `POST /api/watches`, `GET /api/watches`, `DELETE /api/watches/:id`.
- `POST /api/watches/run` (token-gated). Evaluates every active watch: reruns replay,
  keeps results whose month falls inside `leadWeeks` from today, prices them, and writes
  an `Alert` when `priceRule` passes. Idempotent per `(watchId, cityId, month, day)`.
- **Trigger:** an external scheduler calls `/api/watches/run` daily (Render Cron Job or a
  Claude scheduled task). No in-process timer.
- **Delivery:** alerts show in the NewsTicker (`glyph: "good"`) and an alerts list in the
  journal. An optional `ALERT_WEBHOOK_URL` gets a JSON POST.
- **Events overlay:** committed `data/events.json` with solar eclipses (paths simplified
  to city hits) and major recurring events. Shown as markers on replay grid cells and
  usable as a replay constraint (`constraints.tags: ["eclipse"]`).

## 11. Phases and definition of done

Each phase ends with `bun run typecheck && bun run test && bun run build` green.

**P1: Journal core.** Done when: a manual journey with 2 stops and 2 flights can be
created, edited and deleted, persists across restarts, and draws on the globe.
Unauthenticated `/api/journal` returns 401.

**P2: Fingerprint & Replay.** Done when: fingerprints for a known journey are stable
across runs (unit test with fixture weather), `POST /api/replay` ranks results and
reports `scoredOn` and universe size, and moving a slider re-ranks visibly. With no LLM
key and no flight keys, replay still works, with price marked mock.

**P3: Ingestion.** Done when: uploading a fixture mbox yields correctly clustered draft
journeys, a re-upload creates no duplicates, and accepting a cluster produces a confirmed
journey with provenance on every item.

**P4: Watches, agent tools, events.** Done when: a watch run against fixture prices
writes exactly one alert per qualifying window and none on a second run the same day,
and the agent mock path answers the §9 example with tool calls and surfaced places.

## 12. Tensions to rule on (open ones now listed in README.md, "Known gaps")

T1 auth on bookings · T2 in-app LLM provider · T3 seasonality coverage backfill ·
T4 crowd data source · T5 weekly resolution. The wiki that held the full text has been removed; see README.md.

## 13. Out of scope

Multi-user accounts, sharing/public journal pages, storing photos, live (non-test)
Duffel payments, hotel price search, mobile app, migrating client Trips to the server.

## 14. Planner rulings (made during the build)

- **R1 Token absent → fail closed.** If `MERIDIAN_TOKEN` is unset, gated routes return
  401 with `{error: "journal_locked", reason: "token_not_configured"}`. Comparison is
  constant-time. Local dev sets `MERIDIAN_TOKEN` in `.env`. The browser client stores
  the token the user pastes in once (localStorage key `meridian.token`) and sends it as
  the Bearer header; 401 shows an unlock prompt.
- **R2 Bookings stay ungated in this build** (T1 open, default = separate change).
- **R3 Months are 1-based** in every journal/replay/watch API and type.
- **R4 Promotion of past bookings** runs lazily: whenever the import queue is read
  (`GET /api/import/queue`), booked bookings with a past departure that are not yet
  candidates are added (`source: "booking"`, `sourceRef = booking id`).
- **R5 FX:** `server/lib/fx.ts` converts via Frankfurter (`api.frankfurter.app/{date}?from=X&to=EUR`),
  cached per (date, currency) on disk. Network failure → `eur` falls back to the latest
  cached rate for that currency; if none, the request fails validation with a clear error
  rather than storing a guessed number. EUR→EUR is identity with no network call.
  Clients may send `Money` without `eur`/`rateDate`; the server fills them.
- **R6 Observed weather** uses the Open-Meteo archive daily endpoint for the exact stay,
  cached on disk per (cityId, arrive, depart). Quota/network miss → weather dims
  `pending`; recompute retries on next fingerprint request.
- **R7 (design gaps, 2026-10-30):** `ReplayResponse.grid` carries stage-1 scores for all 12
  months of each result city (dense replay rows). `ObservedConditions.normalTempC` added.
  `constraints.cityIds` added (row-level watches). Alerts API lives under the gated
  watches prefix: `GET /api/watches/alerts`, `POST /api/watches/alerts/:id/seen`.
  Import additions (task P): `POST /api/import/cluster/:id/merge {journeyId}`,
  `PATCH /api/import/:id {cityId?|fromCityId?|toCityId?}` to resolve cities in review,
  uploads at `POST /api/import/upload/email` (raw .eml/.mbox body or multipart) and
  `POST /api/import/upload/timeline` (JSON body), and `POST /api/import/photos`
  (array of `{timestamp, lat, lng, hash}`).
- **R8 (replay template climate + save latency, 2026-10-30):**
  (1) When a template journey/stop has weather dims pending or absent, replay fills the
  template's missing `comfort`/`tempC`/`precipMm` from the stops' seasonality normals
  (each stop at its own dominant month, nights-weighted across stops), so the tempC bend
  still bends. This is a per-request template only; the stored fingerprint stays
  `pending`. `ReplayResponse.templateClimate` reports `"observed"` (real stay weather, or
  values given in a partial fingerprint), `"normal"` (filled from normals) or `"none"`.
  (2) Saves never wait on network: the `onJourneySaved` listener only schedules a
  background fingerprint that runs after the write and persists via `mutateJourney`
  guarded by `inputsHash` (an edit made meanwhile is never overwritten).
  `whenFingerprintsSettled()` awaits outstanding jobs. `GET /api/journal/:id/fingerprint`
  still computes on demand (8s budget; weather past it stays `pending`).
