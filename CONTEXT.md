# Meridian

Travel-intelligence app: a flat map over a world city database, with trip planning,
flight booking (test mode), seasonality insight, a travel journal, and an AI research agent.

The UI is described by `docs/design/DESIGN-v3.md` (brief) and `src/shell/CONTRACT.md` (how the screens fit).
Those supersede the UI sections of the older `docs/design/DESIGN-*.md` files. User-facing labels differ from
some terms below: "Repeat a trip" for Replay, "When to go" for the seasonality heatmap, "Crowds"
for the crowd proxy, "Ask" for the agent panel.

## Language

### Places and data

**City**:
A destination row from the world cities dataset, matched to a primary airport (IATA)
where one exists. The unit everything else references by `cityId`.
_Avoid_: place (see Open Place), destination, location

**Region**:
A continent or subregion grouping of cities, used for aggregate views.

**Comfort Index**:
The 0–100 monthly seasonality score for a city, derived from multi-year climate
normals (temperature comfort minus precipitation penalty minus air penalty minus desert penalty, ADR 0014, ADR 0018).
Deliberately labeled an index, not "best time" truth. Shown as three terms wherever it is explained.
_Avoid_: weather score, climate score

**Air penalty**:
Points taken off the Comfort Index for a month's mean PM2.5 (CAMS via Open-Meteo): nothing at 10 µg/m³
or less, 40 at 75 or more. A place with no air figure yet loses nothing and says so; it is never read as clean.
_Avoid_: pollution score

**Weekly normals**:
The 52 week-of-year climate normals of a city (temperature, rain per 7 days, PM2.5), averaged over the
climate window from daily data and lightly smoothed. Where a city has them, Repeat a trip and When to go can
work by week; where it doesn't they fall back to months, labelled. Not interpolated from months.
_Avoid_: week data

**Climate cell**:
A 0.25 degree grid square holding the monthly and weekly normals shared by every city inside it
(`data/climate-normals.json`). The unit the climate backfill fetches and dedupes by.

**Granularity**:
How local a measured value is: city, region (a NUTS 2 area) or country. Shown beside every figure from place data, with its source and year. A value the sources lack is a gap, shown as "no data", never filled in.
_Avoid_: accuracy

**Place data**:
The measured figures behind cost, rent, internet, healthcare, stability and visitors (`data/country-data.json`, `data/city-data.json`, ADR 0013).

**Seasonality**:
The 12-month Comfort Index profile of a city or region, rendered as a heatmap calendar.

**Climate Traits**:
What a month is like beyond comfort, read from the same normals (`src/lib/climate.ts`):
warmth (freezing to hot), wetness (arid to very wet), greenery (a rain-times-warmth
vegetation proxy, not satellite data) and snow. The map searches and filters by them.
_Avoid_: weather type

**Condition**:
One searchable climate trait value ("Warm", "Dry", "Lush", "Snowy"). Conditions OR within
a group and AND across groups.

**Anomaly**:
A map marker for something to avoid or watch: a standing conflict, a standing advisory
(a known problem such as unsafe rail), a recurring seasonal hazard (`data/phenomena.json`),
or a live news alert placed on a country's capital.

**Issue**:
A problem detected from a country's headlines over the past year, by subject (rail, air,
roads, ferries, buildings, power, water, outbreaks, crime, strikes, corruption). Levels:
*pattern* (two corroborated deadly incidents, or one plus corruption or accountability
coverage), *recent incident*, *recurring* (repeated disruption). Not hand-curated.

**Watch Flag**:
A risk topic (transport, unrest, governance, safety, health, utilities, hazard, conflict)
that a place's own headlines keep raising: once with deaths, or repeatedly with disruption.
Shown in the city panel under the curated advisories.
_Avoid_: incident, disaster (too narrow)

**Likeness** (ADR 0019):
How alike two places are in experience: whether the same traits stand out (mountains, water,
sea, heritage, how photographed, notable places, size), whatever their size. Measured, not rated.
_Avoid_: similarity score, match

**Vibe**:
A named experience to look for ("Old towns", "Mountain lakes", "Winter sun"): levels on a few
experience axes, set at the data's 95th percentile, and sometimes a climate or latitude range.
_Avoid_: tag, category

**Strength**:
How much of an experience a place carries: its projection onto what was asked for, over the
traits that stand out. Shown against the strongest alike place (100).

**Source**:
An alike place with (nearly) the most of the experience: the real thing.
_Avoid_: original, best

**Echo**:
An alike place with clearly less of it than a Source, linked to the Source it most resembles
("a lighter Venice"), with what it lacks and what it offers instead (cheaper, fewer visitors).
_Avoid_: copy, knock-off, dupe

### Trips and booking

**Trip**:
A named, ordered list of city nodes (legs between consecutive nodes), kept in the browser
and synced to the server while the journal is unlocked (ADR 0006). A trip is a Season you can
take any year; choosing a year makes it concrete (ADR 0007).

**Season**:
The months a trip or a stop happens in, with no year: a MonthSpan such as February to July,
wrapping the new year when it starts after it ends. Each stop can carry its own months; the
trip's season runs from the first placed stop to the last.
_Avoid_: dates, trip dates (those exist only once a year is chosen)
_Avoid_: itinerary (that is the dated plan a trip gets once it has a year)

**Leg**:
The segment between two consecutive trip nodes, identified by `tripId` + `legIndex`.

**Itinerary**:
The concrete side of a Trip once it has a year (ADR 0010): arrival and departure dates on
each stop, a Stay, Activities, notes, and Recorded Bookings on legs. A trip with no year has
none; it is still a Season.
_Avoid_: schedule, plan (a Trip is the plan)

**Nights**:
How long a trip stop lasts, derived from its arrival and departure dates. Never stored.

**Stay**:
Where you sleep at a trip stop: name, address, check-in and check-out, price, booking
reference, link. The planned counterpart of a Journey's lodging.
_Avoid_: accommodation, hotel (it may be a flat or a friend's)

**Activity**:
Something planned at a trip stop, with an optional day, time and cost. Becomes an
Experience once it has happened.
_Avoid_: event (that's a Meridian Event), experience (that's the journal's)

**Mode**:
How a Leg is travelled: flight, train, bus, ferry or drive. Defaults from distance and
Landmass; the traveller can change it. Only flight legs reach flight search.
_Avoid_: transport type

**Landmass**:
The piece of land a City sits on (`data/city-geo.json`, from Natural Earth). Two cities with
the same landmass can be reached over land; different ones have the sea between them.

**Leg Plan**:
The Mode and Recorded Booking of one Leg, stored on the stop it arrives at (the trip's
`homeLeg` for the way back) and stamped with the city it leaves from. Ignored when the route
is reordered and the stamp no longer matches.

**Recorded Booking**:
A booking made on another site and written down on a Leg by hand: carrier, number,
reference, price, local times. What makes a leg "booked". Not a Booking, which is a test
order made inside Meridian.
_Avoid_: booking (alone), ticket

**Hand-off**:
A "Book on…" link that opens another site's real search with the route, date and travellers
prefilled as far as that site allows. Meridian never takes payment.
_Avoid_: checkout, affiliate link

**Share Link**:
A revocable, unguessable URL to a read-only page of one trip's itinerary. Shows no booking
references, prices, notes or traveller details.

**Calendar Feed**:
A revocable, unguessable URL a calendar app subscribes to for one trip (ICS). Same privacy
as a Share Link. The downloaded calendar file is the owner's own and includes references.

**Offer**:
A priced, bookable flight quote from a provider (Duffel) or the mock generator.
Ephemeral — expires in minutes and is never persisted.
_Avoid_: quote, fare

**Estimate**:
A non-bookable indicative price for a leg (mock formula or SerpAPI insight). Distinct
from an Offer: an Estimate informs, an Offer books.

**Booking**:
The durable, server-persisted aggregate created by accepting an Offer: leg snapshot,
passengers, order reference, status (`booked`/`cancelled`), provenance
(`duffel-test`/`mock`). Self-contained — references a Trip leg but does not depend on
server-side trip state.
_Avoid_: order (that's Duffel's word for their side), reservation

**Booking Reference**:
The airline/provider record locator returned when a Booking is created.
_Avoid_: PNR, confirmation code

### Agent

**Agent**:
The tool-calling AI loop behind `/api/agent/chat` that researches places by invoking
Tools, streaming its steps to the client.

**Tool**:
A plain, deterministic server function (`search_places`, `get_place_images`,
`get_seasonality`, `get_flight_estimate`) exposed to the Agent and callable directly by
legacy endpoints and the mock path.

**Open Place**:
A city the Agent has surfaced during research, accumulated in the dedicated places
tab/modal with images and seasonality, ready for user action (shortlist, trip, book).
_Avoid_: result, suggestion, candidate (that's Trip Candidates)

**Mock Path**:
The keyless degradation mode: same Tools, same response shapes, deterministic output,
always visibly labeled as mock.

**Shortlist**:
The server-persisted set of cities the user has flagged for consideration.

### Journal and replay

**Journey**:
Something that happened: dated stops, segments, stays and experiences, with spend, rating
and notes. Not a Trip, which is a plan.
_Avoid_: trip (for past travel), itinerary

**Stop**:
A city within a Journey, with arrival and departure dates and an optional rating.
_Avoid_: node (that's a Trip node)

**Segment**:
A move between two cities within a Journey (flight, train, bus, car, ferry, other).
_Avoid_: leg (that's a Trip Leg)

**Experience**:
A dated activity in a city within a Journey, with optional cost and rating.
_Avoid_: event (that's a Meridian Event)

**Provenance**:
Where a record came from: `source`, an optional `sourceRef` used for dedupe, and `confidence`.
_Avoid_: origin

**Fingerprint**:
The conditions a Journey or Stop actually met: month, observed comfort, temperature, rain,
daily spend, flight cost per 1000 km, crowd proxy, nights. Each dimension is `ok`,
`pending` or `absent`.
_Avoid_: signature, profile

**Template**:
The Fingerprint that Replay matches against, before any Bend.
_Avoid_: pattern, reference

**Bend**:
Slider offsets applied to a Template before matching (temperature, spend, crowd, month
shift). Shifts the target; constraints filter the candidates.
_Avoid_: filter

**Window**:
A destination City × month pair. The unit Replay ranks. Monthly in v1.
_Avoid_: slot, cell (a cell is the heatmap view of a Window)

**Replay**:
Ranking Windows by similarity to a Template after its Bend. Deterministic: no LLM in the
scoring.
_Avoid_: simulation, recommendation

**Import candidate**:
A proposed Journey record (segment, stop, stay or experience) from an ingestion source,
held for review until accepted, merged or discarded. Nothing from ingestion becomes a
Journey unreviewed.
_Avoid_: candidate (alone, see Trip Candidates), draft journey

**Cluster**:
A suggested Journey: Import candidates grouped by date proximity.
_Avoid_: group, bundle

**Inbox**:
The review screen (`#/inbox`) for Clusters and Import candidates. Its pending count shows as
a badge on Inbox in the sidebar and the phone tab bar.

**Crowd proxy**:
A 0–100 estimate of how busy a City is in a month, from its comfort-peak curve and holiday
overlap. Always labeled a proxy; a per-stop user override wins.
_Avoid_: crowd score, crowd data

**Watch**:
A saved Replay query that runs daily and checks whether a top-matching Window has come
into booking range at a qualifying price.
_Avoid_: alarm, subscription

**Alert**:
What a Watch writes when a Window passes its price rule. One per Window per day.
_Avoid_: notification

**Promote**:
Turning a Trip and its Bookings into a Journey, or a past Booking into Journey Segments.
_Avoid_: import (imports are Import candidates)

**Repeat**:
Creating a Trip from a Journey or a Replay result so the existing booking flow applies.
_Avoid_: rebook, clone

### Access (ADR 0009)

**Owner**:
The one person a Meridian deployment belongs to. Everything personal (Journeys, Trips sync,
Bookings, Watches, the Inbox) and everything that spends a provider key is the Owner's alone.
_Avoid_: user, admin, account

**Sign-in**:
Entering the password (the server's `MERIDIAN_TOKEN`) once per browser. The UI still says a
screen is "locked" or "private" until then.
_Avoid_: unlock with a token, paste the token

**Session**:
What Sign-in gives the browser: a signed cookie the browser sends by itself and scripts
cannot read. It carries a user id (always "owner"), expires, and ends on sign-out.
_Avoid_: token (the browser no longer holds one)

**Bearer token**:
`MERIDIAN_TOKEN` sent in an `Authorization` header by automation (the import task, cron).
Never used by the browser.

**Lockout**:
The pause on Sign-in after too many wrong passwords, per client and overall.
_Avoid_: ban, block

**Gate**:
The check that a request comes from the Owner (Session or Bearer token). A gated route
answers 401 without one.

**Paid route**:
A route that calls a provider billed or metered per call (Claude, Duffel, SerpAPI,
Open-Meteo on demand). Paid routes are rate-limited; with the provider's key set they are
also gated, and without it they serve the Mock Path.

**Rate limit**:
The per-client (and overall) cap on calls to a Paid route. Over it, the answer is 429 with
the seconds to wait.
_Avoid_: throttle, quota (quota is the provider's)


### Rotation (ADR 0011)

**Rotation**:
Where the Owner lives next: a rolling 12–18 month calendar of Rotation Stays, with no
return leg and an optional home airport. Not a Trip, which leaves a departure and comes back.
_Avoid_: itinerary, long trip

**Rotation Stay**:
One place held in a Rotation: a base or a pass-through, with move-in and move-out days or a
Month Window, minimum and maximum nights, budget and rent per month, lodging, notes and a
status (idea, planned, booked, current, done). "Stay" alone still means a trip stop's lodging.
_Avoid_: stop (that's a Journey's), node (that's a Trip's)

**Base**:
A Rotation Stay of weeks or months, lived in.

**Pass-through**:
A Rotation Stay of a few days in a hub or on the way, such as Bangkok between two bases.

**Month Window**:
The months a Rotation Stay should fall in (YYYY-MM to YYYY-MM) before its dates are fixed.
Gaps and overlaps against it are tentative.

**Locked**:
A Rotation Stay a re-planning solver must keep where it is.

**Personal Window**:
The Owner's own peak, shoulder or avoid months for a place, with a reason ("burning season,
air quality"). Overrides the Comfort Index wherever a Rotation is scored or shown.
_Avoid_: Window (that's Replay's City × month), season

**Place Profile**:
What the Owner keeps about one place across stays: its Personal Windows and Lead Time.

**Fit**:
How well a Rotation Stay's months suit its place: great, good, fair, poor, avoid or unknown,
from Personal Windows first and the Comfort Index where there are none.

**Current Location**:
The committed Rotation Stay containing today. On a moving day, the one moved into.

**Move**:
Travel between two consecutive committed Rotation Stays, estimated like a Trip Leg.
_Avoid_: leg (that's a Trip's), segment (that's a Journey's)

**Lead Time**:
How many weeks before moving in a stay should be booked: a default by type and length,
overridden per place or per stay.

**Book-by Date**:
Move-in day (or the Month Window's first day) minus the Lead Time. A Reminder is due from
two weeks before it.

**Stay Template**:
A Rotation Stay made from a past Journey's stop: place, type and length, and its real cost
scaled to a month, with no dates.

**Notice**:
A message Meridian raises for the owner (a watch Alert, a test, later a booking reminder),
written to the notice log first and then sent through every Channel that is set up. The
in-app Alerts list is the log. The same dedupe key is the same Notice and is sent once.
_Avoid_: notification (an Alert is the Watch's own record; a Notice carries one)

**Channel**:
One way a Notice leaves the server: email, Telegram, ntfy, Web Push or the webhook. Each is
optional and fails on its own.

**Daily job**:
Work registered with `registerDailyJob` that runs once per UTC day, from the in-process
scheduler on a long-running server or from Vercel Cron.

**Private cache**:
What the service worker keeps of the owner's data for offline reading. Emptied on sign-out
and on any 401, and never holds sign-in state or share links.

### Solver and re-planning (ADR 0015)

**Rotation Solver**:
Proposes whole rotations from a Pool for the next 12–18 months, keeping fixed stays where
they are. Deterministic: the same input and seed give the same proposals.
_Avoid_: optimiser, AI planner

**Pool**:
The places the solver may use, each a base or a pass-through with its own minimum and
maximum nights and, optionally, the owner's own monthly figure.

**Proposed Rotation**:
One complete plan the solver returns, with its score broken into six components (fit, cost,
travel, visa margin, risk, preferences) and the next-best Alternatives for each stay.
_Avoid_: solution, result

**Alternative**:
Another pool place for one stay of a Proposed Rotation, on the same dates, with the score
difference and what changed most.

**Fixed Stay**:
A stay the solver and plan B keep exactly: locked, booked, or where the owner is on the
start day.

**Preference**:
A weighted fuzzy wish the solver scores but never enforces: somewhere in a region in some
months, by the sea in some months, at most N long-haul flights a quarter.
_Avoid_: constraint (those are hard)

**Schengen Buffer**:
A stay outside the Schengen Area placed after Schengen stays because another Schengen stay
there would break 90 days in any 180. The visa module (ADR 0012) suggests them, ranked by
distance and comfort, and the solver adds the best two to the Pool when it has none in reach.

**Border Run**:
Two nights in another country that restart a per-entry limit, inserted only when the owner
allows them, and only to a country the passport enters on arrival. Useless against a rolling
window, and said so.

**Shift**:
A measured change about the current or an upcoming stay (fresh news, a new advisory, air or
temperature against normal, a fare change, a day-count breach) with a magnitude against its
threshold.
_Avoid_: alert (that's a Watch's), event

**Proposal**:
What the re-plan check raises when a Shift fires: the evidence with sources and plan B as a
diff against the active rotation. Changes nothing until the owner accepts it; can be
dismissed or snoozed.
_Avoid_: suggestion, recommendation

**Plan B**:
The best Proposed Rotation from today with the shifted place penalised or excluded and every
Fixed Stay kept.

**Hysteresis**:
The margin a continuous Shift must clear past its threshold to fire, and fall below it to
clear, so a reading near the line neither fires nor flaps. With the cooldown (a week by default),
one Shift raises at most one Proposal per cooldown.

### Visas and day counting (ADR 0012)

**Passport**:
A passport the Owner holds, by issuing country, with an optional expiry (Settings › Visas). With
several, each check uses the one with the easiest entry and names it.

**Entry Requirement**:
What a passport needs to enter a country: none (visa free), a visa on arrival, an ETA, an
e-visa, a visa before travel, or no entry; "free movement" inside the EU, EEA and Switzerland.
From Passport Index Data, with curated rows where they are newer or more specific.
_Avoid_: visa status

**Day Limit**:
How long the Entry Requirement allows and how the days count: per entry, in a rolling window
(90 in any 180), or per calendar year. Entry and exit days both count.
_Avoid_: allowance, quota

**Schengen 90/180**:
The 29 Schengen countries share one rolling count: 90 days in any 180. Cyprus and Ireland are
in the EU but outside it. Does not apply with an EU, EEA or Swiss passport.

**Curated Rule**:
A hand-written row in `data/visa-curated.json` (a zone, a regime, a nomad visa, a yellow-fever
requirement, a tax test, a border-run note), each with a source link and the date it was checked.

**Verdict**:
One stay checked: within limit, close to it, over it (with the first day over), visa first, no
entry, free, or no data; with passport validity and yellow fever flags.

**Violation**:
A Day Limit the whole plan breaks, from the first day over; past breaches before today are history.

**Passport Validity**:
How long a passport must outlast the arrival or the departure (FCDO's wording per destination,
kept word for word, read into months or days where plain).

**Tax Days**:
Days present in a country per period (calendar year, tax year or any 12 months), counted against
that country's sourced test or the general 183-day rule of thumb. Not tax advice.
_Avoid_: residency days (the test decides residency; days are only one input)

**Legal Residency**:
The country the Owner is tax-resident in and wants to keep. Its counter is shown apart; the
others warn as they near their test.

## Bridges (ADR 0017)

**Bridge**:
A read-only connection to a service the Owner already uses (Notion, Gmail) that lands what it
finds where the Owner already reviews it: Notion in Personal Windows and the Candidate Pool,
Gmail in the Inbox.

**Candidate Pool**:
The Owner's Location Research entries from Notion, matched to cities: the notes, monthly budget
range, stay range and the Owner's own scores. The places a Rotation could use; they are not
stays and carry no dates. The Rotation Solver offers them as Pool places.
_Avoid_: shortlist (that's the saved places on the map)

**Import Preview**:
The diff an import would make (Personal Windows added, changed, removed; pool entries; review
items), shown before anything is written. Applying it is refused if the source changed since.

**Review Item** (Notion):
A Notion place name Meridian could not match to one city. The Owner picks the city once; the
answer is remembered as an alias for that name.

**Gmail Sync**:
Finding travel confirmations in Gmail with the stored queries, reading each in memory with the
JSON-LD parser, and landing the fields as Inbox candidates. Backfills year by year, then follows
Gmail's history id. Message content is never stored.

**Future Booking**:
A pending Inbox stay or transport candidate dated today or later. Besides the journal it can
be added to a Trip as a stay or a booking on a Leg.
