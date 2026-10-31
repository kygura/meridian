# DESIGN — Flight Booking Flow UI

> **Superseded for UI (v3).** `DESIGN-v3.md` and `src/shell/CONTRACT.md` replace every UI,
> layout, visual-language and component section of this document. The old components it names
> (`src/components/**`, `src/pages/**`) and their stylesheets have been deleted; the UI now lives in
> `src/screens/**`, `src/ui/**` and `src/shell/**`. Data contracts, API behaviour and server rules
> described here still apply.

Scope: spec §4.1 (booking pipeline UI) and §5 flow 1. Governed by assumptions A1
(bookings server-side, self-contained; trips stay client-side), A2 (offers ephemeral,
orders durable), A5 (no Duffel key locally → clearly-labeled mock offers; test mode only).

This document is the single source of truth for a no-taste implementer. It defines
entry points, container, steps, the UI state machine, the bookings list, badges,
component boundaries, state ownership, and exact copy/colors. It describes the design in
prose and wireframes only — no JSX/CSS is written here.

---

## 0. Visual language contract (applies to every surface below)

Honor the existing "parchment map / cartographic dispatch" system. Reuse these tokens
from `src/index.css` — never hardcode a themed color the tokens already cover.

| Purpose | Token | Light | Dark |
| --- | --- | --- | --- |
| Page/backdrop | `--bg` | `#f4ecd8` | `#0b0f17` |
| Raised surface | `--paper` | `#fbf5e6` | `#161c2c` |
| Sunk surface | `--bg2` | `#ece1c6` | `#131826` |
| Primary text | `--ink` | `#1c1814` | `#eef2f8` |
| Secondary text | `--ink2` | `#3a342b` | `#b8c2d6` |
| Muted/label text | `--ink3` | `#786f5c` | `#7a8499` |
| Faint text/disabled | `--ink4` | `#b3a98f` | `#4a5468` |
| Hairline border | `--hairline` / `--hairline2` | rgba ink 0.12 / 0.28 | rgba ink 0.10 / 0.28 |
| Accent (brand) | `--accent` | `#c2680c` | `#f59e0b` |
| Positive / booked | `--good` | `#0f766e` | `#2dd4bf` |
| Warning / expired / cancel | `--warn` | `#b3261e` | `#ff5b5b` |
| Hazard / mock | `--hazard` | `#c2680c` | `#f59e0b` |
| Info / test | `--info` | `#1e40af` | `#60a5fa` |
| Hard offset shadow | `--shadow` | `3px 3px 0 #1c1814` | `3px 3px 0 #2dd4bf` |

Fonts: `--display` (Instrument Serif, italic) for large ticket display headers only;
`--mono` (JetBrains Mono) for ALL labels, keys, IATA codes, prices, references, badges,
buttons — always UPPERCASE with `letter-spacing: 0.08em`; `--sans` (DM Sans) for
running body copy (passenger names typed by the user, help sentences).

Structural rules: 1px hairline borders, hard `--shadow` offset (never soft blur) on the
main modal card and on the ticket, no rounded corners beyond the 2px used by badges,
dotted/dashed dividers for "teletype" seams. The look target is an **airline ticket /
teletype dispatch printout**. Skeuomorphic ticket detailing (perforation seam, monospace
record locator, barcode-style motif) is encouraged for the success/ticket surface *only*,
and must never impede function.

New non-token colors needed (define as scoped values; give both themes):

| Purpose | Light | Dark |
| --- | --- | --- |
| MOCK badge fill wash | `rgba(194,104,12,0.12)` | `rgba(245,158,11,0.16)` |
| TEST badge fill wash | `rgba(30,64,175,0.10)` | `rgba(96,165,250,0.16)` |
| BOOKED badge fill wash | `rgba(15,118,110,0.12)` | `rgba(45,212,191,0.16)` |
| Expiry-urgent fill wash | `rgba(179,38,30,0.12)` | `rgba(255,91,91,0.16)` |
| Ticket perforation dots | `--hairline2` | `--hairline2` |

---

## 1. Entry points

### 1.1 Primary — "BOOK" on a trip leg (TripsPage)

The leg row today (`TripsPage.tsx`, the `.tp-leg` block, lines 374–392) renders:

```
[line] 5,432 km   11h 20m   ~$840   via DXB          FLIGHTS ↗
```

Add a booking affordance at the **right end of the leg row**, after the existing
`FLIGHTS ↗` external link. It is a mono uppercase action styled like `.tp-link` but
accented:

```
[line] 5,432 km   11h 20m   ~$840   via DXB   FLIGHTS ↗   ✈ BOOK
```

- Class name: `tp-book-btn` (share `.tp-link` sizing: mono 9px, uppercase, 0.08em).
  Resting color `--accent`; on hover, border and text go to `--accent` at full weight
  with the standard 1px translateY lift used elsewhere.
- Label copy: `✈ BOOK` (the `✈` glyph matches the existing dispatch iconography, e.g.
  `cmd-prompt` uses `✈`).
- Disabled when either endpoint lacks an IATA (`from.iata` or `to.iata` is null). In that
  case render it greyed (`--ink4`, `cursor: default`, `opacity: 0.4`) with `title`
  attribute `NO AIRPORT ON ROUTE`. Do not open the modal.
- Clicking sets the Zustand booking-modal target (`{tripId, legIndex, origin, dest,
  departureDateHint}`) and opens `BookingModal`. The `origin`/`dest` are the leg's
  `from`/`to` `TripNode`s (IATA + name + coords).

When a booking already exists for this `tripId`+`legIndex`, the `✈ BOOK` action is
**replaced** by the booked-leg badge (see §6).

### 1.2 Secondary — from an agent Open Place card

The Open Places panel is owned by another designer (DESIGN-agent-places.md). This
document only defines the **affordance contract** they must satisfy: a card action
labeled `✈ BOOK FLIGHT` that opens the SAME `BookingModal` with a target shaped
`{tripId?: undefined, legIndex?: undefined, origin, dest}`. When there is no trip leg,
`origin` may be undefined — in that case `BookingModal` opens on the CONFIRM step with
the origin field empty and focused, and the destination prefilled from the place. Booking
without a trip leg still persists (the server accepts absent `tripId`/`legIndex` per
spec §4.1). That panel owns its own card styling; it only needs to call the shared open
action. Nothing else in this document depends on that panel.

---

## 2. Container decision — modal overlay (not a page/route)

**Decision: a modal overlay**, reusing the established `.cmd-overlay` + `.cmd-panel`
pattern from `TripCandidates.tsx` / CommandPalette, widened for the checkout.

Justification:
1. **Consistency** — TripCandidates already trains the user that focused travel actions
   open as a dim-backdrop overlay card. A new full route would break that language.
2. **A2 (offers are ephemeral)** — the entire flow is a single, transient session that
   must not survive a reload or become a bookmarkable resting state. A modal reinforces
   "this is a live checkout, offers expire in minutes"; a durable `#/checkout` route
   would imply persistence that directly contradicts A2. Closing the modal discards the
   in-flight offer search by construction.
3. **Context retention** — the trip/leg stays visible dimmed behind the overlay, so the
   user keeps their itinerary context while booking one leg.

Overlay/card specifics:
- Reuse `.cmd-overlay` verbatim (fixed inset, `z-index: 60`, `rgba(28,24,20,0.32)`
  backdrop + 2px blur, flex, top-aligned, `padding-top: 12vh`).
- New card class `booking-panel` analogous to `.cmd-panel` but wider and taller:
  `width: min(760px, 94vw)`, `max-height: 86vh`, `background: var(--paper)`,
  `border: 1px solid var(--ink)`, `box-shadow: 6px 6px 0 var(--ink)`, column flex,
  `overflow: hidden`. The body scrolls internally; the header and footer are pinned.
- Backdrop `onMouseDown` closes the modal **with a guard**: if the user has typed
  anything into the passenger form OR a booking submit is in flight, first swap to an
  inline confirm ("DISCARD CHECKOUT? — details will be lost / KEEP / DISCARD") instead of
  closing outright. Card `onMouseDown` calls `stopPropagation` (same as TripCandidates).
- `Escape` follows the same guard. During `submitting` and `booked` states, backdrop
  and `Escape` do NOT discard silently (see §4).

---

## 3. Checkout steps and layout

The modal is a linear wizard with a persistent header (title + step rail + provenance)
and a persistent footer (contextual actions). Steps: **CONFIRM → OFFERS → PASSENGER →
REVIEW → BOOKED**, with SEARCHING and SUBMITTING as transient overlays on top of OFFERS
and REVIEW respectively.

### 3.0 Persistent header (all steps)

```
┌──────────────────────────────────────────────────────────────┐
│ ✈  BOOK FLIGHT · JFK → DXB                     [MOCK]  [✕]     │
│ ── CONFIRM ──●── OFFERS ──○── PASSENGER ──○── REVIEW ──○ ──── │
└──────────────────────────────────────────────────────────────┘
```

- Title row: `✈  BOOK FLIGHT` in mono uppercase, then `· <ORIGIN IATA> → <DEST IATA>` in
  `--ink3`. Right side: the global provenance badge (§7) and a close `✕` button
  (`tm-action-btn` sizing).
- Step rail: a mono breadcrumb of the four durable steps. Completed = filled dot `●`
  `--ink`; current = `●` `--accent`; upcoming = hollow `○` `--ink4`. Connector segments
  are `1px dashed --hairline2`. Steps are **not** clickable forward; a completed step
  label is clickable to jump back only when going back is safe (allowed back from OFFERS
  to CONFIRM, and from REVIEW to PASSENGER; PASSENGER→OFFERS re-select is allowed and
  keeps passenger data — see §4).
- Class names: `booking-head`, `booking-steprail`, `booking-step` (+ `.done`, `.current`,
  `.upcoming`).

### 3.1 CONFIRM (search params) — component `BookingSearchForm`

Trips have **no dates today**, so a departure date is mandatory here. This is the gate
that turns a dateless leg into a searchable offer request.

```
  ROUTE
  ┌────────────┐        ┌────────────┐
  │ JFK        │  ───▶  │ DXB        │      (readonly when from a leg;
  │ New York   │        │ Dubai      │       editable IATA fields when
  └────────────┘        └────────────┘       opened without a leg)

  DEPART *              RETURN (OPTIONAL)
  ┌──────────────┐      ┌──────────────┐
  │ 2026-08-14   │      │  —  add      │
  └──────────────┘      └──────────────┘

  PASSENGERS
  [ − ]  1  [ + ]      ADULT

               ─────────────────────────
                          [ SEARCH OFFERS → ]
```

- **Route block**: origin and destination as two ticket-chip fields joined by `───▶`.
  When opened from a leg, both are readonly display chips (IATA large mono + city name in
  `--sans` `--ink3` beneath). When opened without a leg (agent path), they are editable
  IATA inputs with the same `CitySearchInput` autocomplete used in TripsPage
  (`searchLocal`), so the user can fix a missing origin.
- **DEPART** (required, marked with `*`): a native `<input type="date">` styled to match —
  mono value text, 1px hairline border, `--paper` fill, min = today (`2026-07-09`).
  Prefill from `departureDateHint` if the caller supplied one; otherwise empty and this
  field gets autofocus. Label copy `DEPART *`. Validation: required, must be ≥ today.
- **RETURN** (optional): same input; empty renders a muted `— ADD RETURN` affordance that
  expands into a date input on click. If set, must be ≥ depart. v1 books one-way OR
  return per what Duffel returns; the search body sends `returnDate?` per spec §4.1.
- **PASSENGERS**: a stepper `[ − ] n [ + ]`, range 1–9, default 1, label `ADULT`/`ADULTS`.
  This count is chosen here (spec §4.1: "count chosen at search"). v1 collects details for
  a **single passenger** (see §3.3) even if count > 1 — see the note there.
- Footer action: `SEARCH OFFERS →` (primary button, see §3.6 button styles). Disabled
  until DEPART is valid. Pressing it transitions to SEARCHING and fires
  `POST /api/bookings/search`.
- Field labels are mono uppercase `--ink3` 9px, 0.08em, sitting above each control (same
  idiom as `.tm-key`).

### 3.2 SEARCHING (transient) — inside `OfferList`

Full-body teletype loader while `POST /api/bookings/search` is in flight.

```
        ▚▚▚  SEARCHING OFFERS  ▚▚▚
        JFK → DXB · 2026-08-14 · 1 ADULT
        querying provider…
```

- Reuse the existing three-dot loading animation used by TripCandidates
  (`.agent-brief-loading` span-triple) centered, plus a mono caption line echoing the
  search params. Copy: `SEARCHING OFFERS`, sub `QUERYING PROVIDER…` (`--ink3`).
- If mock path, the caption may briefly read `NO PROVIDER KEY · GENERATING MOCK OFFERS`
  in `--hazard` — this sets expectation before the MOCK badges appear.

### 3.3 OFFERS (results list) — components `OfferList` + `OfferRow`

```
  OFFERS · 6 FOUND                         SORT: [ PRICE ▾ ]
  ┌──────────────────────────────────────────────────────────┐
  │ ● EK      $842   USD   14h 20m   1 STOP DXB    [MOCK]      │
  │   Emirates          depart 22:10 → arrive 19:30 +1        │
  │                                    EXPIRES IN 18:42  [ SELECT ]│
  ├──────────────────────────────────────────────────────────┤
  │ ● QR      $915   USD   16h 05m   1 STOP DOH    [MOCK]      │
  │   Qatar Airways     depart 09:40 → arrive 08:45 +1        │
  │                                    EXPIRES IN 18:41  [ SELECT ]│
  └──────────────────────────────────────────────────────────┘
```

Each `OfferRow` (class `offer-row`, selectable, styled like `.candidate-row` from
TripCandidates — left color/status bar, hover raises `sel`) shows, left→right / top→bottom:
- **Carrier badge**: 2-letter IATA carrier code in a mono chip + full carrier name in
  `--sans` `--ink3` beneath.
- **Price**: large mono `--ink`, e.g. `$842`, with `USD` currency in `--ink3` beside it.
  This is the total offer price for the passenger count.
- **Duration**: total elapsed `14h 20m` (reuse `formatHours`-style formatting).
- **Stops**: `NONSTOP` (in `--good`) or `1 STOP DXB` / `2 STOPS DXB·DOH` listing
  connection IATAs.
- **Times line** (secondary): `depart 22:10 → arrive 19:30 +1` with `+1` day-offset in
  `--ink3`.
- **Provenance badge** per row: `[MOCK]` (hazard) or `[TEST]` (info) — see §7. Every row
  carries one; the flow must never look like real ticketing.
- **Expiry hint**: `EXPIRES IN 18:42` mono countdown (component `OfferExpiryCountdown`,
  §7.2), driven by the offer's `expiresAt`. Turns `--warn` under 2:00 and pulses.
- **Select action**: `[ SELECT ]` per row; clicking selects the offer, marks the row
  `sel`, and advances to PASSENGER. Whole-row click also selects (mirror `candidate-row`
  behavior).

Header of the list:
- Left: `OFFERS · N FOUND` (mono). If zero offers, show empty state (see §4 error table:
  `no_offers`).
- Right: `SORT:` control cycling `PRICE` / `DURATION` / `DEPART` (a small mono dropdown
  or segmented toggle). Default `PRICE` ascending. Sorting is client-side over the fetched
  offers array.
- A thin secondary line under the header restates params + a global `RE-SEARCH ↻` link
  that returns to CONFIRM (keeps params filled) in case the user wants to change date.

Footer: `← BACK` (to CONFIRM). No forward button here — selection advances.

### 3.4 PASSENGER (details form) — component `PassengerForm`

Collects exactly the fields Duffel requires (spec §4.1): title, given name, family name,
born on (date), gender, email, phone. v1 = single passenger.

Pinned at the top of this step: a compact **selected-offer summary strip** with a LIVE
expiry countdown, so the user always sees the clock while typing.

```
  SELECTED · EK $842 · 14h 20m · 1 STOP DXB · [MOCK]   EXPIRES 15:02
  ────────────────────────────────────────────────────────────────
  PASSENGER 1

  TITLE *          GIVEN NAME *              FAMILY NAME *
  [ MR ▾ ]         [ Aisha            ]      [ Rahman          ]

  BORN ON *        GENDER *
  [ 1990-04-12 ]   [ ◉ FEMALE  ○ MALE ]

  EMAIL *                          PHONE *
  [ aisha@example.com        ]     [ +1 415 555 0142        ]

                         [ ← BACK ]   [ REVIEW → ]
```

- **TITLE**: mono select, options `MR / MRS / MS / MISS / DR`. Maps to Duffel `title`.
- **GIVEN NAME / FAMILY NAME**: text inputs, `--sans` value text (user-typed proper
  names are body copy, not labels). Required, non-empty, letters/spaces/hyphens.
- **BORN ON**: `<input type="date">`, required, max = today, must be a plausible adult/
  child age (no future dates). Label `BORN ON *`.
- **GENDER**: radio pair `FEMALE / MALE` (Duffel v2 uses `m`/`f`). Required.
- **EMAIL**: `type="email"`, required, standard email validation.
- **PHONE**: `type="tel"`, required, E.164-ish (leading `+`, digits). Helper hint under
  the field in `--ink4`: `INCLUDE COUNTRY CODE`.
- All field labels mono uppercase `--ink3`, required marked `*`. Two-column grid on wide,
  single column under ~520px.
- **Multi-passenger note (v1 constraint):** when the search count > 1, show a mono notice
  banner above the form: `BOOKING 1 OF N · ADDITIONAL PASSENGERS NOT COLLECTED IN V1`.
  v1 submits a single passenger in the `passengers` array; the count drives pricing/search
  only. This keeps the form honest rather than silently dropping passengers.
- Footer: `← BACK` (returns to OFFERS, **keeps** entered passenger data) and `REVIEW →`
  (primary, disabled until all required fields valid). Validation errors render inline
  beneath each field in `--warn` mono (see §4 `validation`).

### 3.5 REVIEW + confirm — component `BookingReview`

Final confirmation. Everything the server will receive, laid out as a pre-print ticket
proof, with an unmissable provenance banner and the live countdown.

```
  ┌───────────────── DISPATCH PROOF ─────────────────┐
  │  ⚠ MOCK BOOKING · NOT A REAL TICKET               │  (banner)
  ├───────────────────────────────────────────────────┤
  │  ROUTE     JFK → DXB            DEPART  2026-08-14 │
  │  CARRIER   EK · Emirates        STOPS   1 (DXB)    │
  │  DURATION  14h 20m              CLASS   ECONOMY    │
  ├───────────────────────────────────────────────────┤
  │  PASSENGER  MR AISHA RAHMAN                        │
  │  BORN       1990-04-12   ·   FEMALE               │
  │  CONTACT    aisha@example.com · +1 415 555 0142   │
  ├───────────────────────────────────────────────────┤
  │  TOTAL                                     $842 USD│
  │                              EXPIRES IN 12:20      │
  └───────────────────────────────────────────────────┘

                 [ ← BACK ]   [ ✓ CONFIRM BOOKING ]
```

- **Provenance banner** (full-width, top of the card): mock → `⚠ MOCK BOOKING · NOT A
  REAL TICKET` on the MOCK wash fill, `--hazard` text/border. Test → `TEST MODE ·
  DUFFEL SANDBOX · NO REAL TICKET ISSUED` on the TEST wash, `--info`. This banner is
  mandatory and can never be suppressed (spec §4.1: flow must never look like real
  ticketing).
- Data grid: mono `--ink3` keys, `--ink`/`--sans` values, rows split by dotted seams.
- **TOTAL** row emphasized (larger mono).
- Live `OfferExpiryCountdown` shown here too; if it hits zero on this screen, auto-switch
  to the expired-recovery path (§4) rather than letting the user submit a dead offer.
- Footer: `← BACK` (to PASSENGER) and `✓ CONFIRM BOOKING` (primary, accent-filled).
  Pressing it → SUBMITTING → `POST /api/bookings`.

### 3.5a SUBMITTING (transient)

Cover the review card with a centered mono loader: `ISSUING BOOKING…` + three-dot
animation. Disable backdrop/Escape dismissal during this state (no accidental cancel of
an in-flight order). If the network hangs, after ~20s show a `STILL WORKING…` sub-line;
do not auto-cancel (the order may have been created server-side).

### 3.6 BOOKED (success) — component `BookingTicket`

The payoff. Full ticket skeuomorphism, functional. This same component is reused read-only
in the bookings list (§5).

```
  ╔═══════════════════════════════════════════════════╗
  ║  MERIDIAN DISPATCH            [MOCK]  ·  BOOKED     ║
  ║                                                     ║
  ║   JFK ✈ DXB                                         ║
  ║   New York → Dubai                                  ║
  ║ · · · · · · · · · · · · · · · · · · · · · · · · · · ║  ← perforation
  ║  BOOKING REFERENCE                                  ║
  ║  ┌─────────────┐                                    ║
  ║  │  X7K9Q2     │   ← large mono, boxed              ║
  ║  └─────────────┘                                    ║
  ║                                                     ║
  ║  DEPART   2026-08-14      CARRIER  EK · Emirates    ║
  ║  PASSENGER MR AISHA RAHMAN                          ║
  ║  TOTAL    $842 USD        STATUS   ● BOOKED         ║
  ║                                                     ║
  ║  ▐▌▐ ▐▌▐▌ ▐ ▌▐▌  (barcode motif, decorative)       ║
  ╚═══════════════════════════════════════════════════╝

     [ VIEW ALL BOOKINGS ]        [ DONE ]
```

- Header band: `MERIDIAN DISPATCH` in mono, provenance badge, and `· BOOKED` status in
  `--good`.
- Route in large `--display` italic (`JFK ✈ DXB`) with city names beneath in `--sans`.
- **Perforation seam**: a dotted horizontal rule (`--hairline2`) with two notch
  semicircles at the edges — the one clearly skeuomorphic flourish. Decorative only.
- **BOOKING REFERENCE**: the record locator (`bookingReference` from the server) in the
  largest boxed mono on the surface — this is the artifact the user came for. Include a
  small `COPY` affordance (mono, copies to clipboard, flashes `COPIED`).
- Data grid: depart, carrier, passenger, total, status.
- **STATUS** pill: `● BOOKED` in `--good`; if later cancelled, `● CANCELLED` in `--warn`
  with the whole ticket dimmed (`opacity: 0.6`) and a diagonal `CANCELLED` watermark.
- Barcode motif: a purely decorative row of mono block glyphs; never encodes real data.
- Footer actions: `VIEW ALL BOOKINGS` (opens BookingsPanel, §5) and `DONE` (closes the
  modal). On close, the trip leg now shows the booked badge (§6).
- The card carries `--shadow` and, on success entry, a brief one-shot "print" reveal
  (slide-up + settle, ≤250ms) — subtle, respects `prefers-reduced-motion`.

---

## 4. UI state machine

`BookingModal` owns a discriminated state. States and the exact UI each renders:

| State | Trigger in | Renders | Exits |
| --- | --- | --- | --- |
| `configuring` | modal open | CONFIRM form (§3.1) | `SEARCH OFFERS` → `searching` |
| `searching` | search fired | SEARCHING loader (§3.2) | 200 → `offers`; error → `error:network`; empty → `offers` (empty state) |
| `offers` | offers fetched | OFFERS list (§3.3) | `SELECT` → `passenger`; `RE-SEARCH`/`BACK` → `configuring` |
| `passenger` | offer selected | PASSENGER form (§3.4) | `REVIEW` → `review`; `BACK` → `offers` (keep data) |
| `review` | form valid | REVIEW (§3.5) | `CONFIRM` → `submitting`; `BACK` → `passenger` |
| `submitting` | order posted | SUBMITTING loader (§3.5a) | 200 → `booked`; 409 offer_expired → `expired`; other → `error:network` |
| `booked` | order created | BOOKING TICKET (§3.6) | `DONE`/`VIEW BOOKINGS` |
| `expired` | 409 from search or submit | expired-recovery banner then auto re-search | re-search → `searching` |
| `error:network` | fetch/5xx failure | error panel + RETRY | RETRY → previous step's action |

### 4.1 Expired-offer recovery (the critical path — A2)

Two entry points, one behavior:
1. **Countdown reaches zero** on a selected offer while in `passenger`/`review`.
2. **Server returns the structured 409** `offer_expired` on `POST /api/bookings` (spec
   §4.1: "Expired-offer errors from Duffel map to a structured 409 telling the client to
   re-search").

On either, transition to `expired`:

```
  ┌───────────────────────────────────────────────────┐
  │  ⚠ OFFER EXPIRED                                    │
  │  Offers only live a few minutes. Re-searching the  │
  │  same route now — your passenger details are saved. │
  │                                                     │
  │           ▚▚▚  RE-SEARCHING  ▚▚▚                     │
  └───────────────────────────────────────────────────┘
```

- Banner fill = expiry-urgent wash, `--warn` text.
- **Passenger form data is preserved** in local state across the re-search (this is
  non-negotiable — the user must not retype). Search params (route, date, count) are also
  preserved.
- Auto-fire `POST /api/bookings/search` again → back to `offers`. Because passenger data
  is already valid, the list header shows a hint: `SELECT A FRESH OFFER — DETAILS SAVED`.
  Selecting an offer jumps **straight to REVIEW** (skips re-entering PASSENGER), since the
  form is already complete and valid; the user can still step back to edit.
- If the re-search also returns expired/empty, stay on `offers` empty state with a manual
  `RE-SEARCH ↻`.

### 4.2 Network / server errors (`error:network`)

```
  ⚠ COULDN'T REACH THE BOOKING SERVICE
  The request failed. Your details are saved.
              [ ← BACK ]   [ ↻ RETRY ]
```

- Applies to fetch failures and non-409 5xx on search or submit. RETRY re-runs the last
  action. Passenger + params preserved. For a submit failure specifically, warn softly:
  `IF YOU JUST CONFIRMED, CHECK BOOKINGS BEFORE RETRYING` (the order may have been created
  — avoid double-booking). RETRY on a submit error first calls `GET /api/bookings` to see
  if the order already landed.

### 4.3 Validation errors (`passenger` step, inline)

Not a modal-level state — handled within PASSENGER. On `REVIEW →` with invalid fields,
block the transition, mark offending fields, render `--warn` mono messages beneath them
(`REQUIRED`, `ENTER A VALID EMAIL`, `INCLUDE COUNTRY CODE`, `DATE MUST BE IN THE PAST`).
Focus the first invalid field.

### 4.4 Empty offers (`no_offers`)

`offers` state with zero results renders the `.cmd-empty` idiom: title `NO OFFERS FOUND`,
sub `No bookable offers for this route and date. Try a different date or nearby airport.`
plus a `← CHANGE SEARCH` back to CONFIRM.

---

## 5. Bookings list — component `BookingsPanel`

Bookings are server-persisted and **global** (a booking references a trip leg but does not
require one — A1). They are not per-trip, so the list is a top-level surface reachable
from the Trips page.

### 5.1 Where it lives

Add a `BOOKINGS` entry in the **left aside header** of TripsPage (`.tp-list` /
`.panel-head`, lines 173–177), beside the trip count:

```
  TRIPS                              3
  BOOKINGS ▸ 2                          ← new: mono link, opens BookingsPanel
  [ + NEW TRIP ]
```

- Class `tp-bookings-link` (mono uppercase, `--ink3`, hover `--ink`). The trailing count
  is the number of non-cancelled bookings; `0` still shows the link.
- Clicking opens `BookingsPanel` as a modal overlay (reuse `.cmd-overlay` + a
  `bookings-panel` card, same width family as the command palette, `min(680px, 92vw)`).
  Chosen as a modal (not a new `#/bookings` route) to reuse the existing overlay language
  and avoid adding routing surface; the list is a lookup/aftercare view, not a
  navigation destination. (Alternative considered: a `#/bookings` hash route — rejected to
  keep parity with how TripCandidates and CommandPalette already model transient panels.)

### 5.2 List content

```
  ┌─── BOOKINGS ───────────────────────────── 3 ─── [✕] ┐
  │  X7K9Q2   JFK → DXB   2026-08-14   $842  [MOCK] ●BOOKED │
  │           EK · Emirates · MR AISHA RAHMAN              │
  ├───────────────────────────────────────────────────────┤
  │  M4P1ZC   LHR → SIN   2026-09-02   $1,120 [TEST] ●BOOKED│
  │           SQ · Singapore Air · MS LENA VOSS            │
  ├───────────────────────────────────────────────────────┤
  │  Q9WTV0   CDG → JFK   2026-05-11   $610  [MOCK] ⨯CANCELLED│  (dimmed)
  └───────────────────────────────────────────────────────┘
```

Each row (`booking-row`, styled like `.candidate-row`):
- **Booking reference** (mono, prominent, left) — the record locator.
- **Route** `ORIGIN → DEST` mono IATA.
- **Depart date**.
- **Total price**.
- **Provenance badge** `[MOCK]`/`[TEST]` (§7).
- **Status pill** `● BOOKED` (`--good`) or `⨯ CANCELLED` (`--warn`, row dimmed to 0.6).
- Second line (`--ink3`): carrier + passenger name.
- **Row click** opens the read-only `BookingTicket` (§3.6) for that booking, with a
  `CANCEL BOOKING` action in its footer for `booked` rows.

### 5.3 Cancel action

- In the expanded `BookingTicket`, footer shows `CANCEL BOOKING` (styled like
  `.tm-delete-btn`: `--warn` border/text, fills `--warn` on hover). Uses the same
  two-step confirm pattern already in TripsPage (`CONFIRM CANCEL` / `KEEP`).
- Confirm → `DELETE /api/bookings/:id`. On success the booking's `status` → `cancelled`;
  update the Zustand bookings cache; the ticket flips to the cancelled watermark; the
  corresponding trip leg badge (§6) flips to cancelled and re-exposes `✈ BOOK`.
- Mock and test bookings both cancel through the same endpoint (server marks mock
  cancelled / calls Duffel test cancellation).

### 5.4 Empty state

`.cmd-empty` idiom: title `NO BOOKINGS YET`, sub `Book a flight from a trip leg to see it
here. Bookings are stored on the server.`

---

## 6. Booked-leg badge + leg↔booking link

On a trip leg that has a booking (matched by `tripId` + `legIndex` in the bookings cache),
the `✈ BOOK` action is replaced in the `.tp-leg` row:

Booked:
```
  ... via DXB   FLIGHTS ↗   ● BOOKED · X7K9Q2
```
Cancelled (booking exists but cancelled → allow re-book):
```
  ... via DXB   FLIGHTS ↗   ⨯ CANCELLED   ✈ BOOK
```

- Component `BookingBadge`. Booked variant: BOOKED wash fill, `--good` text/border, mono,
  `● BOOKED · <REF>`. Clicking it opens the `BookingTicket` for that booking directly
  (bypasses the list).
- Cancelled variant: `⨯ CANCELLED` in `--warn` (non-interactive, or opens the cancelled
  ticket), followed by a fresh `✈ BOOK` so the user can rebook the leg. A new booking for
  the same leg supersedes the cancelled one for badge purposes (badge always reflects the
  most recent non-cancelled booking; if none, show cancelled + rebook).
- Matching rule: a leg shows the booked badge when the cache contains a booking with
  `status === "booked"` and matching `tripId`/`legIndex`. Prefer the newest by created
  time if multiple.

---

## 7. Component boundaries, names, and state ownership

### 7.1 Components

| Component | Responsibility |
| --- | --- |
| `BookingModal` | Overlay shell; owns the §4 state machine; routes between steps; owns local checkout state (params, selected offer, passenger draft, error). |
| `BookingSearchForm` | CONFIRM step: route chips, depart/return date inputs, passenger stepper. |
| `OfferList` | SEARCHING + OFFERS + empty states; sort control; holds the fetched offers array (local, ephemeral). |
| `OfferRow` | One offer: carrier, price, duration, stops, times, provenance, expiry, SELECT. |
| `PassengerForm` | PASSENGER step: the 7 Duffel fields + validation; selected-offer summary strip. |
| `BookingReview` | REVIEW step: dispatch-proof grid + provenance banner + confirm. |
| `BookingTicket` | BOOKED success ticket; reused read-only in `BookingsPanel`; hosts cancel. |
| `BookingsPanel` | Global bookings list overlay opened from TripsPage. |
| `BookingBadge` | Leg-row booked/cancelled badge on TripsPage. |
| `ProvenanceBadge` | Shared `MOCK` / `TEST` / `DUFFEL-TEST` pill. |
| `OfferExpiryCountdown` | Shared live mm:ss countdown from an `expiresAt`; warn styling + zero callback. |

### 7.2 `OfferExpiryCountdown` behavior

Takes `expiresAt` (ISO). Renders `EXPIRES IN mm:ss` (mono). ≤ 2:00 → `--warn` text + slow
pulse. On reaching `00:00` fires an `onExpire` callback (used by the selected-offer path
to trigger §4.1 recovery). Uses a single `setInterval(1000)`; clears on unmount. Never
shows negative values (clamps to `EXPIRED`).

### 7.3 State ownership

**Server-fetched, never persisted client-side (A2):**
- **Offers** — from `POST /api/bookings/search`. Held ONLY in `OfferList`/`BookingModal`
  local React state. Never written to Zustand, never to localStorage. Discarded on modal
  close. This is the hard expression of "offers are ephemeral, never a resting state."

**Server-persisted, cached in Zustand (A1):**
- **Bookings** — `GET /api/bookings` fills a `bookings: Booking[]` array in the Zustand
  store. Server is source of truth; the cache exists so trip legs can render badges (§6)
  without each leg fetching, and so `BookingsPanel` opens instantly. Refetch on: app load,
  after a successful `POST /api/bookings`, and after a `DELETE`. **Not** added to the
  localStorage `partialize` allow-list (unlike trips) — bookings live on the server, so
  the cache rehydrates from the API, not from disk.

**Zustand additions (mirror the existing `candidatesOverlayOpen` pattern):**
- `bookingModal: { open: boolean; target: BookingTarget | null }` where `BookingTarget =
  { tripId?: string; legIndex?: number; origin?: TripNode; dest: TripNode;
  departureDateHint?: string }`. Actions `openBookingModal(target)`, `closeBookingModal()`.
- `bookings: Booking[]`, `bookingsPanelOpen: boolean`, `activeBookingId: string | null`
  (which booking the ticket is showing). Actions `setBookings`, `fetchBookings`,
  `setBookingsPanelOpen`, `openBookingTicket(id)`, `applyBookingCancelled(id)`.

**Local (component) state only:**
- Wizard `step`, `selectedOfferId`, `passengerDraft` (the 7 fields), `searchParams`
  (route/date/count), `sortKey`, per-field validation errors, in-flight/error flags.
  `passengerDraft` MUST survive step-back and expired-recovery re-search within a single
  modal session (§4.1); it is cleared when the modal fully closes.

**Types to add (`src/types.ts`):** `Offer`, `Booking`, `Passenger`, `BookingTarget`,
mirroring the server shapes in spec §4.1 (`Offer`: id, price, currency, segments, carrier,
duration, expiresAt, source; `Booking`: id, status, bookingReference, provenance, leg
snapshot, passengers, order snapshot, tripId?, legIndex?, createdAt). Use `zod`-inferred
types if the server exports schemas; otherwise hand-write to match.

---

## 8. Exact label copy (mono UPPERCASE unless noted)

Entry / badges:
- Leg action: `✈ BOOK` · disabled title `NO AIRPORT ON ROUTE`
- Leg booked badge: `● BOOKED · <REF>` · cancelled: `⨯ CANCELLED`
- Provenance: `MOCK` · `TEST` · (list/ticket long form) `MOCK BOOKING · NOT A REAL TICKET`
  · `TEST MODE · DUFFEL SANDBOX · NO REAL TICKET ISSUED`

Header / rail:
- Title: `✈ BOOK FLIGHT` + `· <ORIGIN> → <DEST>`
- Steps: `CONFIRM` `OFFERS` `PASSENGER` `REVIEW`

CONFIRM:
- `ROUTE` · `DEPART *` · `RETURN (OPTIONAL)` / `— ADD RETURN` · `PASSENGERS` ·
  `ADULT`/`ADULTS` · primary `SEARCH OFFERS →`

SEARCHING:
- `SEARCHING OFFERS` · `QUERYING PROVIDER…` · mock: `NO PROVIDER KEY · GENERATING MOCK OFFERS`

OFFERS:
- `OFFERS · N FOUND` · `SORT: PRICE|DURATION|DEPART` · `NONSTOP` · `1 STOP <IATA>` ·
  `EXPIRES IN mm:ss` · row `SELECT` · `RE-SEARCH ↻` · `← BACK`
- Empty: `NO OFFERS FOUND` / body `No bookable offers for this route and date. Try a
  different date or nearby airport.` / `← CHANGE SEARCH`

PASSENGER:
- `PASSENGER 1` · `TITLE *` `GIVEN NAME *` `FAMILY NAME *` `BORN ON *` `GENDER *`
  `EMAIL *` `PHONE *` · title options `MR/MRS/MS/MISS/DR` · gender `FEMALE/MALE` ·
  phone hint `INCLUDE COUNTRY CODE` · multi note `BOOKING 1 OF N · ADDITIONAL PASSENGERS
  NOT COLLECTED IN V1` · `← BACK` · `REVIEW →`
- Validation: `REQUIRED` · `ENTER A VALID EMAIL` · `INCLUDE COUNTRY CODE` ·
  `DATE MUST BE IN THE PAST`

REVIEW:
- `DISPATCH PROOF` · keys `ROUTE DEPART CARRIER STOPS DURATION CLASS PASSENGER BORN
  CONTACT TOTAL` · banner as above · `EXPIRES IN mm:ss` · `← BACK` · `✓ CONFIRM BOOKING`

SUBMITTING: `ISSUING BOOKING…` · slow: `STILL WORKING…`

BOOKED ticket:
- `MERIDIAN DISPATCH` · `· BOOKED` · `BOOKING REFERENCE` · `COPY`/`COPIED` · keys
  `DEPART CARRIER PASSENGER TOTAL STATUS` · `● BOOKED` · `VIEW ALL BOOKINGS` · `DONE`

Expired / errors:
- `⚠ OFFER EXPIRED` / `Offers only live a few minutes. Re-searching the same route now —
  your passenger details are saved.` / `RE-SEARCHING` / list hint `SELECT A FRESH OFFER —
  DETAILS SAVED`
- `⚠ COULDN'T REACH THE BOOKING SERVICE` / `The request failed. Your details are saved.`
  / `↻ RETRY` / submit-specific `IF YOU JUST CONFIRMED, CHECK BOOKINGS BEFORE RETRYING`

BOOKINGS list:
- `BOOKINGS` · header count `N` · row `● BOOKED`/`⨯ CANCELLED` · `CANCEL BOOKING` /
  confirm `CONFIRM CANCEL` / `KEEP`
- Empty: `NO BOOKINGS YET` / `Book a flight from a trip leg to see it here. Bookings are
  stored on the server.`

Discard guard: `DISCARD CHECKOUT?` / `Details will be lost.` / `KEEP` / `DISCARD`

---

## 9. Button style reference (reuse existing idioms)

- **Secondary / navigation buttons** (`← BACK`, `RE-SEARCH`, `DUPLICATE`-class): reuse
  `.tm-action-btn` (mono 9px, 0.08em, 1px `--hairline2` border, transparent, `--ink3`,
  hover lifts `translateY(-1px)` to `--ink2`).
- **Primary / forward buttons** (`SEARCH OFFERS →`, `REVIEW →`, `✓ CONFIRM BOOKING`,
  `SELECT`): a filled variant — `--ink` background, `--paper` text, 1px `--ink` border,
  `--shadow` offset; hover nudges to accent (`background: --accent`, keep `--shadow`).
  Class `booking-primary-btn`. Disabled: `--ink4` bg, no shadow, `cursor: default`.
- **Destructive** (`CANCEL BOOKING`, `DISCARD`): reuse `.tm-delete-btn` (`--warn`).
- **Inline links** (`RE-SEARCH ↻`, `VIEW ALL BOOKINGS`, `COPY`): reuse `.tp-link`.
- Row selection (offers, bookings): reuse `.candidate-row` hover/`sel` treatment (left
  color bar, background lift).

---

## 10. Responsiveness & a11y

- Modal card `width: min(760px, 94vw)`; below ~520px the passenger/review grids collapse
  to a single column; offer rows stack price/duration under the carrier.
- Any overflowing content (long offer list) scrolls **inside** the card body; the page
  behind never scrolls horizontally.
- Focus: on each step transition, move focus to the step's first interactive control
  (CONFIRM → depart date or origin; PASSENGER → title; REVIEW → confirm). Trap focus
  within the modal. `Escape` follows the §2 discard guard.
- Every provenance badge has an accessible label (`aria-label="Mock booking, not a real
  ticket"` / `"Test mode Duffel sandbox booking"`).
- Countdown announces politely (`aria-live="polite"`) only when crossing the 2:00 warn
  threshold and at expiry — not every tick.
- Honor `prefers-reduced-motion` for the ticket "print" reveal and countdown pulse.
- Contrast: all mono labels use `--ink3` or darker on `--paper`; badges rely on the wash
  fills specified in §0 for sufficient contrast in both themes.
