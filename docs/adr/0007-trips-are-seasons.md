# A trip is a season; the year is optional

A trip plans a route you could take any year, so it is anchored to months, not dates. Each stop can carry a `months` span (1–12, inclusive, wrapping the new year when start > end), and the trip's season runs from the first placed stop to the last. A trip with no placed stops can carry its own `season`. Comfort, crowds and recurring events already work by month, so they describe the trip the same way every year.

The year enters only when you get concrete. Setting `year` dates every placed stop (the first day of its first month to the last day of its last, with months before the season's start falling in the next calendar year), prefills flight searches from those dates, and surfaces dated events for that year. Dated events in `data/events.json` now include moving holidays that clash with travel (Tết and Lunar New Year, 2027–2030) alongside eclipses. `GET /api/overlays/events?cityIds=` returns every upcoming event at a trip's cities.

Stops are placed by month, not by day. Nights per stop and exact dates belong to the booking step, where a year and real fares exist.

Rejected: start and end dates on a trip (it ties a reusable plan to one year, and you would re-plan the same route each year), a per-trip season only (one season can't describe a route that follows the dry season from Vietnam to Bali), and day-level offsets within a season (false precision before a year is chosen).
