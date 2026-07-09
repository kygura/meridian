# Bookings are server-side self-contained aggregates; trips stay client-side

A Booking produces a durable order reference, so it must outlive the browser — it is
persisted server-side (flat-file JSON, matching the existing shortlist pattern). But it
snapshots everything it needs (leg, passengers, offer terms, order) and only *references*
`tripId`/`legIndex`, so trips can remain in localStorage untouched. We deliberately did
NOT migrate trips to the server as part of the booking pipeline: coupling the two would
have blocked booking on a risky data migration for no functional gain. Offers are
ephemeral (Duffel offers expire in minutes) and are never persisted; checkout always
books from a fresh offer in one session.
