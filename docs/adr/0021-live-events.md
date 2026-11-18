# Events are fetched live from Wikidata, not kept in the repository

Builds on ADR 0007 (trips are seasons, which surface events), ADR 0016 (daily jobs) and the document store of ADR 0006.

Until now events were `data/events.json`: 44 entries written by hand (six eclipses, Tết and Lunar New Year, a few dozen festivals and races). It went stale the day it was written, covered what one person remembered, and put a fact about the world into the codebase. The owner's rule is that events have to be live and dynamically fetched, not hardcoded. This ADR replaces the file with Wikidata, read at runtime.

## Sources

[Wikidata](https://www.wikidata.org/) (CC0) through its SPARQL endpoint. It needs no key, it carries coordinates, sitelink counts (a usable notability signal) and a month-of-year property for recurring events, and its licence allows caching. Five queries, two at a time:

| Source | Query | Result |
|---|---|---|
| `festivals` | instances of festival (Q132241, subclasses included) with a month of the year (P2922) and at least 8 sitelinks | recurring events |
| `sports` | instances of sporting event (Q16510064) or marathon (Q40244) with a month of the year and at least 12 sitelinks | recurring events |
| `dated-festivals` | festivals with a start time (P580) or point in time (P585) in the next 18 months, at least 5 sitelinks | dated events |
| `dated-sports` | the same for sporting events | dated events |
| `eclipses` | instances of solar eclipse (Q3887, subclasses included) with a point in time in the next 30 months | dated events |

Coordinates come from the item (P625), else its location (P276) or administrative territory (P131). Types (P31) arrive as English labels.

A month item (Q108 January to Q126 December, with April to December at Q118 to Q126) becomes 1 to 12. An item with several months, such as Oktoberfest in September and October, becomes one event per month with ids `wd-Q102400-m9` and `wd-Q102400-m10`; single-month items are `wd-Q12345`. Replay and the map match events by month, so one event per month is what they need.

Kind: sporting items are `sport`, eclipses are `eclipse`, festival items are `culture` when a type names film, music, arts, literature, theatre or dance, and `festival` otherwise (carnival, folk, religious, food). Tags are the kind (plus `festival` for every festival item) and the kebab-case type labels with "annual", "recurring" and "edition of the" removed and generic labels dropped (`film-festival`, `marathon`, `single-day-road-race`, `total-solar-eclipse`).

Dated rows can carry a year-precision date next to the real one (1 January). The query cannot tell precision, so a date on 1 January is read as a year and skipped; an item with only that date is dropped.

## Placing events

Each coordinate goes to the nearest Meridian city within 40 km (a one-degree grid keeps 600 lookups to a few milliseconds). When two cities are within 5 km of each other, the bigger wins. An event with no city is dropped and counted per source. The venue of a festival is rarely a city in the dataset, so this is the nearest known city, not the venue's own town (Cannes lands on Nice).

Wikidata does not give an eclipse's path as cities. An eclipse is placed on the airport cities within 150 km of its point of greatest eclipse (the belt is wide) and on the hub city (the capital if it has an airport, else the largest airport city) of each country Wikidata lists. An eclipse with neither is kept with no cities: it shows in lists but not on the map. Partial eclipses are left out.

## Caching and refresh

`events-live.json` in the document store: `{ version, fetchedAt, attemptedAt, sources, events }`, one status line per source (`ok`, `count`, `unmatched`, `unplaced`, `error`, `fetchedAt`). Events carry `source: "wikidata"` and `sourceUrl` (the item page), and, inside the file only, the source that produced them. The file has a new name, so a stale `events.json` in a runtime disk is never read.

- `refreshLiveEvents` runs the sources and writes the store. The daily job `events` (`server/lib/eventsJob.ts`, imported by `server/app.ts`) calls it, on the in-process scheduler and on Vercel's cron alike.
- `getLiveEvents` is what Replay, Watches, the map overlay and the trip season view call. It reads the store. When the copy is older than 7 days it starts one refresh, shared by concurrent callers, and serves the old copy meanwhile; only an empty store waits. After an attempt it does not start another for an hour. The server also calls it once at start, so a first boot fills the store before anyone asks.
- Consumers keep their rules: recurring events always, dated ones only when still ahead (and, for Replay, only in a month's next occurrence).

## Wikidata etiquette

Two queries at a time (Wikidata allows a few per client), a second between queries in each lane, `User-Agent: Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)` and `Accept: application/sparql-results+json`. A 429 or 503 waits `Retry-After` (at most 60 s, 5 s steps when absent) and retries at most twice, then gives up on that source. The request timeout is 60 s, Wikidata's own query limit, not 30 s: the dated sporting query takes about 22 s. Tests never reach the network (they inject a fetch; without one the code refuses to run under Vitest, and `LIVE_EVENTS=off` turns fetching off anywhere).

## Failure

A source that fails (an error, a timeout, a 429 that persists, or no rows where it had events before) keeps its previous events and its previous `fetchedAt`, and records the error. If every source fails, the store and `fetchedAt` stay as they were. `getLiveEvents` never throws: it returns what it has, or an empty list, and the failure is logged. An empty list means event markers and tag constraints find nothing, not that anything breaks.

## Endpoints

`GET /api/overlays/events` (by month or by cities) now carries `asOf` (the fetch time) and `source: "Wikidata (CC0)"`. `GET /api/overlays/events/tags` lists the distinct tags of upcoming events with counts; Replay's "Happening while you're there" chips load from it. `GET /api/overlays/events/status` shows each source's count, errors and fetch time, with no secrets.

## Known limits, accepted for v1

Wikidata's notability bias is visible: film festivals are about half of the first fetch (159 of 319). Moving holidays such as Lunar New Year, Easter and Diwali are mostly not there, and the Tết and Lunar New Year entries of the old file are gone. Recurring events have a month, not dates. Dated festival items came back empty in the first fetch. Eclipse paths are approximated by a point and a country list, and two of the four eclipses in the window had no city. Tags are whatever Wikidata's type labels say.

Rejected: keeping the hand-written list and refreshing it by hand (it is the problem this ADR removes); PredictHQ and Ticketmaster (paid or keyed, and they cover ticketed shows and concerts rather than seasonal festivals, which is what a season-first planner needs); scraping tourism sites (licences, and brittle); asking the model for events at request time (no sources, not repeatable, and a fabricated date is worse than a missing one).

## Serverless time limits

A Vercel function stops at 60 s, and the five queries take about 35 s together from a cold start, longer from some regions. So a refresh saves each source as soon as it finishes, runs two at a time, and on Vercel stops starting sources after a 45 s budget; the ones left are the oldest-first work of the next run. A request that finds the store empty waits at most 8 s, then answers with whatever has been saved and leaves the rest to fill in. The first preview deployment showed the need: one request ran all five queries in turn, hit the 60 s limit and saved nothing.
