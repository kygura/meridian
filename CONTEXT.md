# Meridian

Travel-intelligence app: a cartographic globe over a world city database, with trip
planning, flight booking (test mode), seasonality insight, and an AI research agent.

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

### Trips and booking

**Trip**:
A named, ordered list of city nodes (legs between consecutive nodes), client-side only,
persisted in the browser.
_Avoid_: itinerary, journey

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
