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
A map marker for something to avoid or watch: a standing conflict advisory or a recurring
seasonal hazard (`data/phenomena.json`), or a live news alert placed on a country's capital.
_Avoid_: incident, disaster (too narrow)

### Trips and booking

**Trip**:
A named, ordered list of city nodes (legs between consecutive nodes), kept in the browser
and synced to the server while the journal is unlocked (ADR 0006).
_Avoid_: itinerary

**Leg**:
The segment between two consecutive trip nodes, identified by `tripId` + `legIndex`.

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
