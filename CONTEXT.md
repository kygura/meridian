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
normals (temperature comfort band minus precipitation penalty). Deliberately labeled an
index, not "best time" truth.
_Avoid_: weather score, climate score

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

