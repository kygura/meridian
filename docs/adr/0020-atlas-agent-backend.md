# Atlas runs on Meridian

Atlas is a scheduled Claude routine (repository `kygura/atlas`) that scouts destinations for the owner's season and location, searches fares with the Claude connectors (Kiwi.com, lastminute.com, Expedia, Booking.com, Viator, Google Calendar, web search), and plans trips. Until now it kept its own state in git: config files, a wishlist cache, flight records and baselines under `data/`, trip plans as JSON, and it delivered through its own Telegram code. Each run ended by merging its branch into `master`.

From this ADR on, Meridian is Atlas's backend. Atlas keeps the judgment (what to scout, what the conditions are, which hotel and activities fit); Meridian keeps the state and the arithmetic.

| Concern | Before (Atlas repo) | Now (Meridian) |
|---|---|---|
| Where the owner is | Google Calendar, then fallback airports | Rotation: the Current Location, else the next stay, else the rotation's home, else the fallback airports. Calendar stays a hint the routine may add |
| Season | the model's web reading | Comfort Index and crowd proxy per month for every wishlist place, plus a seasonal ranking of cities by vibe |
| Wishlist | `config/wishlist.json`, committed | `atlas.json` document, editable from the Atlas terminal client |
| Fare history and baselines | `data/flights`, `data/baselines`, committed | `atlas.json` fares, scored server-side |
| Trip plans | `data/trips/*.json`, committed | Meridian Trips, status `scouting`, with dates, stay, activities and the flight leg. Visa checks, calendar export and share links come with them |
| Delivery | Telegram bot code plus Composio | `notify()` (ADR 0016): the Alerts list plus every configured Channel |
| Promote to `master` | every run | gone: nothing is committed |

## Storage

One document, `atlas.json`, in the shared store (JSON file or Postgres, ADR 0006):

- `config`: traveller profile, hard filters, search windows, scoring and discovery weights, trip preferences, trip profiles. Defaults are the values Atlas shipped with.
- `places`: the wishlist, one entry per city. `source` is `wished` (the owner added it) or `scouted` (a discovery run added it). Any entry can carry a `watch` (notify when a fare clears the deal bar). Wished and watched entries are never removed by a run; only the owner removes them.
- `fares`: priced, non-distorted fares from every scan, newest 20,000, keyed by route (`MAD-LIS`). Baselines are computed from them on each scan, never stored.
- `runs`: the newest 200 run summaries (scan or discovery).

## API (`/api/atlas`, owner-gated, Bearer `MERIDIAN_TOKEN` for the routine)

All bodies and answers are JSON, camelCase. Places in inputs are a `PlaceRef`: `{ cityId }`, `{ iata }` or `{ query }` (a name, resolved with the city search). An unresolved place is reported back, never guessed.

| Method and path | Does |
|---|---|
| `GET /context?today=` | Everything a run starts from: today, the resolved origin and how it was found, the rotation's current and next stay, search windows A and B as dates, config, the wishlist with each place's comfort and crowd for the months the windows touch and its best months, places scouted within the repeat window, the last 5 runs |
| `GET /seasonal?months=1,2&vibe=coast,tropical-coast&profile=surf&limit=25` | Cities with an airport ranked for those months: mean comfort, crowd proxy and, with a vibe or a profile, likeness strength (ADR 0019). Deterministic seed list for scouting |
| `GET /config`, `PATCH /config`, `PUT /config` | Read, deep-merge a patch, or replace. Validated |
| `GET /wishlist`, `POST /wishlist`, `DELETE /wishlist/:cityId` | List; upsert `{ entries: [...] }` by city; remove one |
| `POST /scans` | Score a scan: hard filters, route baselines (median, 25th percentile, count; under 3 records is thin), price against median, composite score, opportunity and baseline-deal flags, validation gates, top pick and alternative, watch hits. Stores the fares and the run |
| `POST /discoveries` | Score discovery candidates with the discovery weights and the repeat penalty, attach each one's measured comfort for the current month, upsert the ones that pass as `scouted` places, store the run |
| `POST /trips` | Turn a trip plan into a Meridian Trip (`scouting`, dated, departure from the origin city, stay, activities, flight leg) and return its id and app link. Same destination and outbound date replace the earlier one |
| `POST /notify` | Raise a Notice of kind `atlas-digest`, `atlas-deal`, `atlas-trip`, `atlas-watch` or `atlas-discovery` |
| `GET /runs?limit=` | Run summaries, newest first |
| `GET /fares?route=MAD-LIS` | One route's baseline and its fares |
| `POST /import` | One-off migration of a legacy Atlas repository: config, wishlist and flight records. Fares already stored are skipped |

### Scoring

Unchanged from Atlas (`src/scoring/engine.ts`, `discovery.ts`), moved into `server/lib/atlas/scoring.ts`:

- Flight composite, 0 to 10: price against the route median (or against a 1,800 EUR reference while the baseline is thin), weather, crowds, surf (only for places tagged surf), isolation, weighted by `config.scoringWeights`.
- `priceVsMedianPct` is (price minus median) over median, so negative is cheaper. At -15 or below the fare is a `baselineDeal`. An `opportunity` is a composite at or above the threshold and a price under 85% of the median.
- Distorted fares (an event drives the price) are stored on the run but kept out of baselines and rankings.
- Discovery composite: weather, tourism season, conditions and price signal (900 EUR reference, 5 when there is none), weighted, minus the repeat penalty for a place scouted within the repeat window.

## What stays in Atlas

The routine prompt (`CLAUDE.md`), the Telegram trigger that fires it (`api/trigger.ts`) and the command parser, and `atlas`, a terminal client for this API (`bun run atlas context`, `wishlist add`, `scan`, `trip`, `notify` and so on) that the routine and the owner both use.

## Rejected

- Atlas writing Meridian's stores directly (shared database or files): it would bypass validation and the gate, and tie Atlas to Meridian's storage format.
- Moving the routine into Meridian's own Ask agent: Ask runs on Meridian's Anthropic key without the claude.ai connectors (Kiwi, lastminute, Viator, Calendar), which are what Atlas needs.
- Agent trip candidates (`origin: "agent"`): those live only in the browser. Atlas trips are ordinary server trips with status `scouting`, so they sync to every device and the owner keeps or deletes them.
