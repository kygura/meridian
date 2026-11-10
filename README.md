# Meridian

A personal travel planner on a world map. Plan trips as routes between cities, see when each place is at its best, book test flights, keep a journal of past travel, and find new places that match trips you liked.

Live: https://meridian-mocha-iota.vercel.app

## What's in it

| Screen | What it does |
|---|---|
| **Map** | Flat map of ~5,900 cities matched to their airports, labelled in English, in each city's own language and script (東京, Москва, القاهرة), or both (Layers › Cities). Click a city for scores, climate, and a neutral briefing of what's happening there, written by Claude Haiku from the headlines (no headlines printed, numbered sources at the bottom; rule-based without an Anthropic key). The briefing leads with problems detected from the country's headlines (e.g. repeated deadly rail crashes followed by fraud probes and protests reads as a rail-safety pattern; also air, roads, power, water, outbreaks, crime, strikes, corruption). Layers tint countries by comfort, temperature, rain, greenery or air quality for any month, search cities by conditions ("warm dry", "lush", "snow"), colour and filter cities by safety, quality of life, internet, cost and crowds, and mark events, conflicts, seasonal hazards and news alerts. |
| **Trips** | Planned trips as seasonal routes: each stop sits in the months it works best, with its comfort and events, and you pick a year only when you want dates and flights. With a year, a trip takes an itinerary: dates and nights per stop, where you're staying, activities, a day-by-day view with date conflicts flagged, and legs by flight, train, bus, ferry or road. "Book on…" opens the real search on Google Flights, Skyscanner, Kayak, Rome2Rio, Booking.com, Airbnb or Flatio with the route, dates and travellers filled in; you record the booking back on the trip. Export the trip to your calendar (.ics file or a private feed) and send a read-only share link. Plus past journeys from the journal. |
| **Plan › When to go** | Month-by-month (or season, or week-by-week) comfort index per city or region, from 2015–2024 climate data. The index is temperature comfort minus rain minus air quality (monthly PM2.5, 2023–2025); each cell's popover shows the three parts, and Air is a metric of its own. Weeks need a city's weekly normals; others show their month flat, labelled. |
| **Plan › Live & love** | Every city by quality of life (human development, life satisfaction, safety, air) against beauty (natural setting and built character), with a "best of both" ranking. The city panel shows each score's parts and the facts behind them. |
| **Plan › Repeat a trip** | Ranks city × month windows by how closely they match a past journey, with sliders to shift temperature, budget, crowds and month. "Match by Week" (under When) ranks city × week-of-year windows for cities with weekly normals and falls back to months for the rest. |
| **Plan › Watches** | Saved Repeat-a-trip searches, checked daily, that alert when a match comes into booking range at a good price. |
| **Plan › Flights** | Flight search and test bookings in Duffel's test mode (mock offers without a key), labelled as test throughout. Nothing is ticketed or charged; results link out to the same search on real booking sites. |
| **Inbox** | Review queue for imports (past bookings, photo locations, Google location history, booking emails) before they become journal entries. Photos never leave the device; only time, place and a hash are sent. |
| **World** | Travel news and country stats by region. |
| **Ask** | Research assistant that searches places, pulls images and checks seasonality. Runs on Claude (pick Opus 5.5, Sonnet 5.5 or Haiku 5.5 in the panel) with an Anthropic key, or a deterministic mock without one. |
| **Rotation** | Where you live next, separate from trips: a 12–18 month calendar of bases and pass-throughs with no trip home. A timeline coloured by fit (your own peak, shoulder and avoid months for a place first, otherwise the comfort index), gaps and overlaps flagged, the route on the globe, moves between stays with flight or ground time and cost estimates, totals (months covered, cost per month, moves per year), what's next (days left here, next move), and book-by dates from lead times you can set per place, with Flatio, Airbnb monthly and Booking.com searches filled in. Add stays from a planned trip or a past journey's stop. Owner only. |
| **Rotation › Solve** | Proposes 3–5 complete rotations from a pool of places (from your rotation, shortlist, past journeys or search) for a budget, with weighted preferences ("Southeast Asia Nov–Feb", "by the sea in summer", "one long-haul a quarter") and hard rules (Schengen 90/180, your country limits, internet and healthcare floors, months you avoid). Side by side on one timeline and the map, each with its score explained (fit, cost, travel, visa margin, risk, preferences), the next-best alternatives per stay, Schengen buffers and border runs marked. Lock a stay and re-solve, swap a stay, and make one your rotation. Ask can run it too. Owner only. |
| **Rotation › Re-plan** | A daily check of where you are and your next stays: fresh news issues, new advisories, air and temperature against normal, fare changes on the next move (with a flight provider), and day-count breaches. When something crosses a threshold, a plan B with its evidence and a diff (dates, cost, Schengen days, travel) waits here to accept, snooze or dismiss; nothing changes until you accept. It and book-by reminders also go out as alerts. |
| **Settings › Re-planning** | Turn the daily check on or off, its thresholds (news level, air, temperature, fare change, book-by notice, hysteresis, quiet days), and run it now. |
| **Settings › Inbox** | Connect Gmail (read-only, Google sign-in) so flights, stays, trains and tickets in your mail arrive in the **Inbox** on their own, daily. Only dates, places and prices are kept, never the messages. Bookings dated in the future can be added to an upcoming trip as a stay or a booked leg. Without Google credentials it says what to set, and uploading an `.eml` or `.mbox` file in the Inbox works the same way (ADR 0017). |
| **Settings › Notion** | Import your own Travel Seasons as personal windows in the Rotation, and your Location Research as a pool of candidate places, from the Notion API or from an uploaded export. You see a diff first; places Meridian cannot match to a city wait for your choice. Re-importing updates, never duplicates (ADR 0017). |
| **Settings › Account** | Sign in as the owner with the server's password, and sign out. Screens that hold personal data, and Ask and flight search once they spend a provider key, show a sign-in card until then. |
| **Alerts** | Every Notice Meridian has raised (watch alerts, test alerts), newest first, with a badge on the sidebar and the phone's More tab. Works with no channel set up. |
| **Settings › Alerts** | Which channels are set up (push, email, Telegram, ntfy, webhook), turn push on for this device, send a test alert. |
| **Offline** | Installable (manifest and icons). The app, its fonts, the city and climate data and the last-synced journal, bookings, watches and alerts open without a connection; trips and itineraries show this browser's copy, and edits sync when you're back. An "Offline" pill shows while it's using saved data; other changes need a connection. A new version shows a reload prompt. |

`CONTEXT.md` defines the terms used throughout the code (Trip vs Journey, Leg vs Segment, Window, Watch, and so on).

## Stack

- **Frontend:** React 19, Vite 6, TypeScript, Zustand, MapLibre GL. Hand-written CSS.
- **Server:** Hono on Node 22 (`tsx`), zod validation.
- **Storage:** one document store with two backends: JSON files under `DATA_DIR`, or Postgres when `DATABASE_URL` is set (ADR 0006).
- **External services, all optional:** Anthropic Claude (assistant and news briefing), Duffel and SerpAPI (flight prices), Open-Meteo (climate), Wikipedia/Wikimedia (images), Google News search RSS (city and country headlines; Google allows personal, non-commercial use of these feeds).
- **Tests:** Vitest. CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull request.

## Data sources

- Cities: `data/worldcities.csv` (name, coordinates, country, population; origin not recorded in this repo), matched to airports from [OurAirports](https://ourairports.com/data/) and capitals from [mledoze/countries](https://github.com/mledoze/countries).
- Native city names: [Wikidata](https://www.wikidata.org/) (CC0), matched through [GeoNames](https://www.geonames.org/) ids (CC BY 4.0). Rebuilt with `scripts/build-native-names.ts`.
- Climate: [Open-Meteo](https://open-meteo.com/) historical data, 2015–2024.
- Quality of life: [UNDP Human Development Index](https://hdr.undp.org/), [World Happiness Report](https://worldhappiness.report/) via [Our World in Data](https://ourworldindata.org/), [World Bank](https://data.worldbank.org/) homicide and PM2.5 data, and [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (CAMS) for major cities.
- Beauty: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), [Natural Earth](https://www.naturalearthdata.com/) lakes, UNESCO World Heritage sites from Wikidata, [Wikimedia Commons](https://commons.wikimedia.org/) and English Wikipedia geotags. Built with `scripts/build-livability.ts`; method in ADR 0008.
- Time zones and landmasses per city (`data/city-geo.json`): [Natural Earth](https://www.naturalearthdata.com/) 1:10m land (public domain) and [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup) (CC0, from timezone-boundary-builder). Rebuilt with `npx tsx scripts/build-city-geo.ts`; method in ADR 0010.
- Distance to the sea per city (`data/city-coast.json`, the solver's "by the sea"): [Natural Earth](https://www.naturalearthdata.com/) 1:10m coastline (public domain). Rebuilt with `npm run build:coast`; method in ADR 0015.
- Trip cost estimates: transport figures are stated formulas (distance × a rate per km), never fares. A stay is estimated only from your own journal's past stays, otherwise it reads "not estimated".
- Map label fonts: Instrument Serif and Noto (SIL OFL 1.1), see `public/fonts/LICENSE.md`.

## Run it locally

```sh
npm ci
cp .env.example .env        # everything in it is optional for local use
npm run dev:all             # app on http://localhost:5173, API on :3001
```

Without any keys the app runs fully on mock data, clearly labelled. Personal data goes to `data/` as JSON files.

To use the journal, trips sync, bookings, Repeat a trip and Watches, set `MERIDIAN_TOKEN` in `.env` and sign in with the same value under **Settings › Account**. The browser keeps a session cookie, not the password (ADR 0009).

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
| `npm run build:place-data` | Rebuild `data/country-data.json` and `data/city-data.json` from Eurostat, World Bank, Ookla and Wikipedia (hours; `PAGEVIEW_MAX`, `OOKLA_QUARTER` limit it; cached in `data/cache/realdata`) |
| `npm run build:coast` | Rebuild `data/city-coast.json` (distance to the sea for cities within 100 km) from Natural Earth's 1:10m coastline |
| `npm run build:seasonality` | Rebuild `data/seasonality.json` from Open-Meteo (needs Bun) |
| `npm run backfill:climate` | Fill `data/climate-normals.json` (monthly PM2.5, weekly normals) cell by cell within Open-Meteo's free-tier limits; resumable. `-- --wait` sleeps through limits, `-- --dry-run` prints the plan |

## Configuration

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Postgres for personal data. Required on hosts without a persistent disk (Vercel) |
| `DATA_DIR` | Where JSON files and caches go when there's no database. Default `./data` |
| `MERIDIAN_TOKEN` | The owner's password (Settings › Account) for the journal, trips sync, bookings, Repeat a trip, imports and watches, and the Bearer token for automation. Also needed to create a trip's share link and calendar feed; the links themselves open without it, since each carries its own token and can be turned off from the trip. Unset means those stay locked |
| `SESSION_SECRET` | Signs the session cookie. Optional: when unset the key is derived from `MERIDIAN_TOKEN`, and changing the password signs every browser out |
| `SESSION_TTL_DAYS` | How long a sign-in lasts. Default 30 |
| `CRON_SECRET` | Vercel only. Lets the daily job run pass the gate: its own value (accepted for `/api/jobs/daily` and `/api/watches/run` only) or the same value as `MERIDIAN_TOKEN` |
| `MERIDIAN_ALLOWED_ORIGINS` | Only if the frontend is served from another origin than the API: comma-separated origins allowed to call it with the session cookie |
| `TRUST_PROXY` | Number of proxy hops in front of the server, so rate limits and the sign-in lockout see the real client address. Not needed on Vercel |
| `RATE_LIMIT` | `off` disables the rate limits (local load tests only) |
| `ANTHROPIC_API_KEY` | Claude for Ask, city research and the news briefing, instead of the mock and rule-based paths |
| `AGENT_MODEL` | Default Claude model for Ask and research (`claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`). Default `claude-opus-5-5` |
| `NEWS_BRIEF_MODEL` | Model for the city news briefing. Default `claude-haiku-5-5` |
| `DUFFEL_API_KEY`, `SERPAPI_KEY` | Real flight offers and prices instead of mock ones. Also let the re-plan check watch the next move's fare (it never uses mock prices) |
| `ALERT_WEBHOOK_URL` | Where every Notice is POSTed as JSON (`text`, `kind`, `title`, `body`, `url`) |
| `PUBLIC_URL` | The app's public address, so alerts sent by email, Telegram, ntfy and webhook can link back. Falls back to `RENDER_EXTERNAL_URL` or Vercel's production URL |
| `RESEND_API_KEY` or `SMTP_URL`, with `ALERT_EMAIL_TO` | Email alerts. `SMTP_URL` is `smtp://user:pass@host:587` (or `smtps://` for port 465). `ALERT_EMAIL_FROM` sets the sender (Resend's test sender only delivers to your own Resend address) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram alerts |
| `NTFY_TOPIC` | ntfy alerts. `NTFY_SERVER` for a self-hosted server (default `https://ntfy.sh`), `NTFY_TOKEN` for a protected topic |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. Make keys with `node scripts/generate-vapid.mjs`; the subject is a `mailto:` or https address that push services may see. Then subscribe each device in Settings › Alerts |
| `DAILY_JOBS_AT`, `DAILY_JOBS` | Time (UTC, `HH:MM`, default 06:17) of the in-process daily run on a long-running server; `DAILY_JOBS=off` turns it off. Vercel uses its cron instead |
| `CLIMATE_JOB`, `CLIMATE_JOB_HOUR_UTC`, `CLIMATE_JOB_BUDGET` | The nightly climate backfill: `CLIMATE_JOB=off` disables it, it runs at the given UTC hour (default 3) and spends up to the budget of weighted Open-Meteo calls (default 2500, about 29 cells). Runs in the long-lived server (`npm start`), not on Vercel; there use `npm run backfill:climate` |
| `OPEN_METEO_MINUTELY_BUDGET`, `OPEN_METEO_HOURLY_BUDGET`, `OPEN_METEO_DAILY_BUDGET` | Our own ceilings on weighted Open-Meteo calls, kept under the free tier's 600 / 5,000 / 10,000. Defaults 400 / 3500 / 7000 |
| `NOTION_TOKEN` | Notion internal integration token for the Notion import. Share your databases with that integration. Without it, upload a Notion export instead |
| `NOTION_SEASONS_DB`, `NOTION_RESEARCH_DB`, `NOTION_RESEARCH_PAGE` | The Travel Seasons database, and the Location Research database or page. Ids or links; Settings › Notion can override them |
| `NOTION_WRITE_BACK`, `NOTION_WRITE_BACK_DB` | `NOTION_WRITE_BACK=1` allows writing the rotation back to a Notion database (also switched on in Settings). Off by default |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` | In-app Gmail import: a Google OAuth web client with the Gmail API enabled, and a secret of 32+ characters that encrypts the saved refresh token (`openssl rand -hex 32`). Register `<your address>/api/gmail/callback` as the redirect URI |
| `GOOGLE_REDIRECT_URI`, `GMAIL_BACKFILL_FROM_YEAR` | Set the redirect URI when a proxy hides the public address; how far back the first sync reads (default three years) |
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
plans/          seasonal trip plans as an importable file (Settings › Trips › Import)
docs/
  adr/          architecture decisions, numbered
  design/       UI and feature design briefs
  specs/        build specs and task logs, kept for history
  DEPLOY.md     hosting
```

## Known gaps

Open decisions carried over from the old wiki:

- **Rate limits are per server process.** On Vercel each warm instance counts on its own and forgets on a cold start, so the limits on Ask, news and flight search slow abuse down but are not a hard budget (ADR 0009). The sign-in lockout is stored and does not have this gap.
- **Climate coverage is partial and fills in slowly.** Open-Meteo's free tier allows about 80 climate cells a day, so the committed `data/climate-normals.json` holds the first 39 of 5,463 cells (49 cities with weekly normals, 48 with air quality; 134 of 5,878 cities have any monthly figure, counting the 120-city seed and on-demand fetches). The nightly job and `npm run backfill:climate` close the rest, about 70 days of quota. Cities without air or weekly data show "no data yet" and fall back to months; the air penalty is not applied to them.
- **Crowds are real only in part.** Country arrivals per resident cover most cities; monthly busyness is measured only in Europe (Eurostat nights) and for 920 big cities (Wikipedia views, a weak signal). Elsewhere it falls back to the labelled comfort-curve proxy (ADR 0013).
- **Cost and rent are mostly country-level.** City-level cost exists for 181 cities and rent for 41 (Eurostat); the rest use the World Bank price level, marked as a country figure and an estimate. Cities in countries with no price level show no cost.
- **Real booking is a hand-off.** Meridian never takes payment. Flights and stays are booked on other sites and recorded on the trip by hand; nothing checks a recorded booking against the airline.
- **Ground transport is a guess.** The mode defaults from distance and landmass, and times and costs are formulas. There is no timetable, rail-network or fare data.
- **Stay prices have no market source.** Only prices you enter, or your own journal's past stays, are used.
- **The solver knows one visa rule.** Schengen 90/180 is built in; every other limit (days per entry, days in a window) is one you enter, and tax days use the general 183-day test. There is no visa database (ADR 0015).
- **The solver is a beam search over half months.** It is fast and explains itself but is not exhaustive, and it places stays on the 1st and 16th except around fixed stays.
- **Some re-plan shifts depend on outside services.** Fare shifts need `DUFFEL_API_KEY` or `SERPAPI_KEY`; temperature shifts use the ERA5 archive (5 days behind, with a shared daily quota); air shifts need the place's PM2.5 normal from the climate backfill. Whatever can't be checked is listed as not checked.
- **The Notion and Gmail bridges are tested against mocked HTTP only.** Neither the Notion API nor a live Google consent was reachable where they were built (ADR 0017). Mail without schema.org markup is counted and skipped, not read by a model; the stored prompt in `docs/ingest/gmail-import-task.md` still covers that.
