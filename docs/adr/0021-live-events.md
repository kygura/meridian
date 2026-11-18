# Events are fetched live, and mean festivities, eclipses, nature and tourism seasons

Builds on ADR 0007 (trips are seasons, which surface events), ADR 0013 (measured visitor nights), ADR 0016 (daily jobs) and the document store of ADR 0006.

Until now events were `data/events.json`: 44 entries written by hand (six eclipses, Tết and Lunar New Year, a few dozen festivals and races). It went stale the day it was written, covered what one person remembered, and put a fact about the world into the codebase. The owner's rule is that events have to be live and dynamically fetched, not hardcoded. The first version of this ADR replaced the file with Wikidata festivals and sporting events. The first real fetch showed the wrong mix: 159 of 319 events were film festivals and 81 were sports.

The owner then said what they mean: "By events I mostly mean local festivities, eclipses, tourism seasonality, and unique events specific to the location (for example, cherry blossom season in Japan)." This ADR now covers that. No list of events or dates is in the codebase. What the code does hold is definitions: which Wikidata classes to include or leave out, which species to look up, which latitude counts as aurora country.

## What was dropped, and why

Film, music, theatre, arts, literature, comics and pride festivals, conferences, and all sports (recurring and dated) are gone, with their queries, fixtures and tests. They are what Wikidata has most of, not what the owner plans trips around. The dated sporting query was also the slow one (18 to 45 s). Dated festival items had come back empty. A stored copy from the first version may still hold such events: a feed that no source produces is dropped when a source is saved, and the read path filters those feeds too.

## Sources

| Source | From | Result | Due |
|---|---|---|---|
| `festivities` | Wikidata | recurring local festivals, month from P2922 | 7 days |
| `national-festivities` | Wikidata | country-wide festivals, on a capital and its biggest airport cities | 7 days |
| `eclipses` | Wikidata | solar eclipses (kind `eclipse`) and total lunar eclipses (kind `sky`) | 7 days |
| `jma` | Japan Meteorological Agency | cherry blossom and autumn leaves by station, matched to Japanese cities | 7 days |
| `inaturalist` | iNaturalist | nature seasons by place, from monthly observation counts | rolling, 30 days per check |
| `aurora` | computed, and NOAA SWPC | northern lights season, plus a live alert at Kp 5 | 3 hours |
| `tourism-seasons` | computed from Meridian's own data | peak and shoulder seasons | at read, nothing stored |

### festivities

Instances of festival (Q132241, subclasses included) with a month of the year (P2922) and at least 5 sitelinks, minus festival classes the owner does not mean: film, music, theatre, arts, literature, dance, comedy, poetry, photography, pride, queer culture, sculpture, science, storytelling, puppet, arts and crafts, comic conventions, ancient Roman festivals, conferences, anime and gaming conventions. The classes are Wikidata QIDs in `server/lib/events/wikidata.ts`, checked against the live labels. The first query excludes by class per type, which keeps it near 1 to 2 s. An item can carry a plain "festival" type next to a film or sport type, so a second query asks Wikidata which of the candidates are of an excluded class or of sport (sporting event, marathon). A backstop regex drops titles and types that name film, music, pride, books, a race or awards. Items with an end date (P576) are skipped, which covers most ancient festivals; those without coordinates fall out at placing.

An item with several months (Oktoberfest) is one event with `months: [9, 10]`. Each is placed on the nearest city within 40 km, the bigger of two cities within 5 km winning; one with no city is dropped and counted. A first run gave 58 events from 83 candidates, with 8 excluded and 17 unplaced.

### national-festivities

Items with a country (P17), a recurrence, at least 20 sitelinks, no coordinates and no venue, in a country that still exists. The recurrence is a month of the year (P2922) or a day in the year (P837). Wikidata gives Holi, Diwali, Songkran, Day of the Dead, Lunar New Year, Tết, Chuseok and the like no month of their own, so P837 is read:

- a Gregorian month, or "April 13", is a recurring month;
- a Hindu lunar month name ("Ashvin Shukla Pratipada") is mapped to the Gregorian month its bright fortnight usually falls in. The lunar month drifts about a month a year, so these events say the month is approximate;
- a Chinese-calendar day ("15th day of the 8th month", "Lunar/Lunisolar New Year's Day") is resolved to Gregorian dates with the runtime's ICU Chinese calendar for the next 18 months, and becomes dated events (a day can be off when the new moon is near midnight);
- anything else (Easter-relative, Thai lunar, Islamic) is counted as undated and left out.

The owner asked to drop items listed in more than about 8 countries. Diwali lists 11 and is one of the festivals asked for, Nowruz lists 23 and is not, so the limit is 12. Types must name a festival, carnival, religious holiday or new year, or be a bare holiday or annual event with 30 sitelinks; titles with "Day" or "Eve", independence days, national days, races, prizes and the like are dropped. The filter still lets a few observances through (Feast of the Annunciation, St John's Eve). Each festival is placed on the country's capital and its 3 biggest airport cities from the city dataset, at least 30 km apart. A first run gave 35 events from 239 candidates and 36 kept, 2 undated and 1 in no known country.

### eclipses

Solar eclipses (Q3887, subclasses included, next 30 months) are placed as before: on airport cities within 150 km of the point of greatest eclipse and on the hub city of each country Wikidata lists. Total lunar eclipses (Q19693318, next 36 months) are kind `sky`, tagged `lunar-eclipse`, and go on the hub cities of the countries Wikidata lists, if any. Wikidata files most lunar eclipses under the plain class, so few qualify: the first run found one, June 2029, with no city. An eclipse with no city is kept and shows in lists, not on the map. Partial and penumbral eclipses are left out.

### jma

The Japan Meteorological Agency publishes phenology tables per station: `sakura003_07.html` (first flowering, 2021 to 2026 and the normal), `sakura004_07.html` (full bloom) and `phn_014.html` (maple colouring, with the difference from the normal). The index (`index.html`) is read first for the page names, with the known names as fallback. The pages are UTF-8.

A station becomes a city when its Japanese name equals a city's `nativeName` (width-normalised, a trailing 市, 町, 村 or 区 dropped; the biggest city wins a tie). There is no romanised fallback: a JMA station name is Japanese and nothing in the dataset derives from it. In the first run 48 of 58 cherry blossom stations and 45 of 51 maple stations matched; the unmatched names (網走, 熊谷, 甲府, 銚子, 彦根, 奈良, 高知, 名瀬, 石垣島, 南大東島) are counted and left out.

One "Cherry blossom" event per matched station: the months run from the normal first-flower date to the normal full-bloom date. One "Autumn leaves" event per matched station with an observed date and a stated difference: the normal is the observed date minus that difference. Both are recurring, tagged `nature`, and carry a `date`: the latest observed date when it is within the last 30 days or the next 12 months, else the normal projected to its next occurrence.

### inaturalist

A list of phenomena (`server/lib/events/phenomena.ts`) says what to look up, not what exists: cherry blossom outside Japan, jacaranda, lavender, tulips and bluebells (flowering annotation), humpback and grey whales, sea turtles, monarchs, fireflies and wildebeest. Each has a minimum number of observations and, where it makes sense, a latitude band. Taxon ids are resolved at run time with `GET /v1/taxa?q=<name>` (the exact name with the most observations) and cached in the store. For a place, `GET /v1/observations/histogram` with `interval=month_of_year`, a 50 km radius and `verifiable=true` gives counts per month. When the total reaches the minimum, the peak months are the run of months holding at least 15% of the year's observations around the busiest month; a flat year makes no event. One event per place and phenomenon, with `months` and a note that says how many observations stand behind it.

iNaturalist asks for about one request a second and at most 10,000 a day, with a User-Agent. The source is rolling: a run makes at most 35 checks (and the taxon lookups), never-checked pairs first, then the oldest, with the owner's places (Atlas wishlist, shortlist, rotation stays and places, trip stops) before the 150 airport cities with the most Wikipedia page views in `city-data.json`. A result is kept for 30 days. After two empty checks for a phenomenon in one country, its other places there are skipped for 30 days. The state saved in the store is the taxon ids, and per check the time and twelve monthly counts; observations are CC BY-NC per observer, so none is kept. Each check is saved when it finishes. A first run of 35 checks over 151 places found 10 events; about 1,190 checks were due, so a full pass takes weeks.

### aurora

Computed: a city's geomagnetic latitude comes from the centred dipole formula with the pole at 80.7 N, 72.7 W. Cities at 62 degrees or more share one "Northern lights season" event over September to March (142 cities in the dataset); cities at -62 or less would get a southern one over March to September (none do). Live: the NOAA SWPC planetary K-index forecast lists Kp per three hours; when the highest predicted or estimated value in the next 72 hours reaches 5, a dated "Aurora alert (Kp N)" goes on cities at 55 degrees or more geomagnetic latitude (north or south). If SWPC is unreachable the seasons stay and the alert is missing until the next run, three hours later.

### tourism-seasons

Derived at read time from Meridian's own data, never fetched and never stored (up to two events for each of a few hundred cities would add 1 MB of rewrites to every save). For a city with measured monthly visitor nights (ADR 0013, `measuredBusyness`), one recurring "Peak season" over the months at 80 or more of 100. Where the city's Comfort Index curve is cached, one "Shoulder season" over the months next to the peak with a Comfort Index of 60 or more. A city with only the comfort-curve crowd proxy gets nothing. The first run gave 643 cities with measured data and 668 events (25 shoulder seasons: only cities whose climate is already cached qualify). The result is kept for an hour. Status shows the counts.

## Kinds and months

`MeridianEvent.kind` is `festival`, `eclipse`, `sky`, `nature` or `season`; `sport`, `culture` and `other` stay in the type for stored data from the first version. `months` (optional, in calendar order from `month`) holds the months of a window, and `note` one line of detail. `month` stays the first month, so older readers work. The map month filter, Replay's month matching and the trip season view match any of `months`. Tourism seasons are left out of the map's points by default (`GET /api/overlays/events?month=N` takes `seasons=1`): a peak season for 640 cities would bury the markers. They stay in a city's list (`?cityIds=`), trip seasons and the tag chips. Markers are coloured by kind and the map shows a key.

## Placing and caching

`events-live.json` in the document store: `{ version, fetchedAt, attemptedAt, sources, events, state }`, one status line per source (`ok`, `count`, `unmatched`, `unplaced`, `detail`, `error`, `fetchedAt`). Events carry their `source` (`wikidata`, `jma`, `inaturalist`, `noaa-swpc`, `meridian`) and a `sourceUrl`, and, inside the file only, the feed that produced them. `state` holds the iNaturalist taxon ids and monthly counts. The file name is unchanged from the first version.

- `refreshLiveEvents` runs the sources and writes the store. The daily job `events` (`server/lib/eventsJob.ts`) calls it for every source, on the in-process scheduler and on Vercel's cron alike.
- `getLiveEvents` is what Replay, Watches, the map overlay and the trip season view call. It reads the store, adds the computed events, and, when a source is due (never landed, or older than its own interval), starts one refresh of the due sources, shared by concurrent callers, serving the old copy meanwhile; only an empty store waits. After an attempt it does not start another for an hour (two minutes while some source has never landed). The server also calls it once at start.
- Consumers keep their rules: recurring events always, dated ones only when still ahead (and, for Replay, only in a month's next occurrence).

## Etiquette

Wikidata: two queries at a time, a second between sources in each lane, `User-Agent: Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)` and `Accept: application/sparql-results+json`. A 429 or 503 waits `Retry-After` (at most 60 s, 5 s steps when absent) and retries at most twice, then gives up on that source; the request timeout is Wikidata's own 60 s. JMA: the index and three pages, 0.5 s apart, once a week. iNaturalist: one request a second, the same User-Agent, at most 35 checks a run, a 429 stops the run and keeps what was saved. SWPC: one small request every 3 hours. Tests never reach the network (they inject a fetch with recorded responses; without one the code refuses to run under Vitest, and `LIVE_EVENTS=off` turns fetching off anywhere).

## Failure

A source that fails (an error, a timeout, a 429 that persists, or no events where it had events before and it is not allowed to be empty) keeps its previous events and its previous `fetchedAt`, and records the error. A rolling source keeps what it saved before the failure. The aurora and nature sources may legitimately return no events; the aurora seasons are computed, so only the live alert is missing when SWPC is down. If every source fails, the store and `fetchedAt` stay as they were. `getLiveEvents` never throws: it returns what it has, or an empty list, and the failure is logged.

## Endpoints

`GET /api/overlays/events` (by month or by cities) carries `asOf` (the fetch time) and `source` (the list of sources). `GET /api/overlays/events/tags` lists the distinct tags of upcoming events with counts; Replay's "Happening while you're there" chips load from it, now with tags such as `cherry-blossom`, `peak-season`, `fireflies` and `aurora`. `GET /api/overlays/events/status` shows each source's count, detail, errors and fetch time, with no secrets.

## Serverless time limits

A Vercel function stops at 60 s. A refresh saves each source as soon as it finishes (a rolling source after each check), runs two at a time, and on Vercel stops starting sources and checks after a 45 s budget; the rest is the oldest-first work of the next run. A request that finds the store empty waits at most 8 s, then answers with what has been saved; the rest keeps running through the request's `waitUntil`. A source already running may use 10 s past the budget. Requests refresh only the sources that are due; the daily job refreshes every source. A full sequential run against the live services took 93 s: Wikidata 31 s over five queries (the solar eclipse query was the slowest at 17 s), JMA 3 s, iNaturalist 52 s for 35 checks and 11 taxon lookups at one a second, SWPC 0.2 s. On Vercel the iNaturalist lane stops at the budget and checks fewer.

## Known limits

Wikidata's notability bias remains: well-known festivals appear and small local ones are mostly absent. A "festival" that Wikidata gives no film or music type can pass the filters. Moving festivals have no month in Wikidata and are read as described above; Easter-relative, Thai lunar and Islamic ones are not covered. The national filter still lets some observances through. Few lunar eclipses are classed as total. JMA matching depends on the dataset's native names. Observations on iNaturalist show where people look, so a season there is a measured tendency, not a forecast. Tourism seasons come from nights in tourist accommodation at region or country level, not from the city. Tags are whatever Wikidata's type labels say, plus the tags above.

Rejected: keeping the hand-written list and refreshing it by hand (it is the problem this ADR removes); PredictHQ and Ticketmaster (paid or keyed, and they cover ticketed shows and concerts rather than seasonal events); scraping tourism sites (licences, and brittle); a fixed list of cherry blossom or whale places (that is an event list in the code, which the phenomenon definitions are not); asking the model for events at request time (no sources, not repeatable, and a fabricated date is worse than a missing one).
