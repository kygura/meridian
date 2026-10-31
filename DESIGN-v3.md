# Meridian v3 — redesign brief

Meridian is a personal app for three jobs: **see** where you've been and where you're going, **log** trips, and **manage** upcoming travel. Everything else serves those three.

This brief replaces the old UI conventions: the parchment atlas look, hard offset shadows, serif display type, mono uppercase labels, the 3D globe, the left and right drawers, the news ticker, the command palette, the theme-wipe animation, and overlay-on-globe pages. No old component or CSS class carries over as-is. The server, `src/lib/*` logic and `src/types.ts` stay; the UI on top of them is rebuilt.

Every existing feature stays reachable: map, planned trips, flight booking, journal, fingerprint, replay, watches and alerts, import inbox, seasons heatmap, chat agent with trip candidates, news and region intel.

## 1. Principles

1. **One thing per screen.** Each screen has one primary action, shown as the only filled button.
2. **Plain words.** Sentence case everywhere. No jargon in labels ("Repeat a trip", not "Replay"; "Crowds", not "crowdProxy").
3. **Content first.** Chrome is quiet: hairline borders, no decoration, no texture.
4. **Phone is first-class.** Every screen works at 390px with no horizontal scroll and 44px touch targets.
5. **Fast paths.** Logging a past trip takes one sheet. Adding a city to a plan takes one tap from the map.

## 2. Information architecture

Five destinations, plus one global panel.

| Nav | Hash | What it holds |
|---|---|---|
| Map | `#/` | Flat map of past journeys, planned routes and bookings. Tap a city to open its panel. |
| Trips | `#/trips` | Segmented **Upcoming / Past**. Upcoming lists planned trips with bookings attached. Past is the journal timeline. |
| Plan | `#/plan/<tab>` | Tabs: **When to go** (seasons heatmap), **Repeat a trip** (replay), **Watches** (watches + alerts), **Flights** (flight search and bookings). |
| Inbox | `#/inbox` | Import: upload files, review clusters, accept into the journal. Badge shows the pending count. |
| World | `#/world` | News and region intel: a news list plus region metric cards. Replaces the ticker and metric panels. |
| Ask | panel, not a route | Chat agent. Opens from the nav and from city panels. Shows agent trip candidates inline. |

Detail routes:
- `#/trips/plan/<tripId>`: planned trip editor (stops, reorder, legs, booking per leg, status).
- `#/trips/past/<journeyId>`: journey detail (stops, segments, experiences, fingerprint, "Repeat this trip").
- `#/plan/repeat/<journeyId>/<stopIndex>`: replay seeded from a journey.

Legacy hashes redirect: `#/journal` → `#/trips/past`, `#/journal/<id>` → `#/trips/past/<id>`, `#/journal/inbox` → `#/inbox`, `#/journal/replay/...` → `#/plan/repeat/...`, `#/seasons` → `#/plan/when`, `#/trips/<id>` → `#/trips/plan/<id>`.

Global actions:
- **Log a trip** (primary, in the sidebar and a floating button on Map and Trips › Past) opens the quick-log sheet.
- **Ask** toggles the chat panel.
- Theme toggle (light / dark / system) and journal unlock live in a **Settings** popover at the sidebar foot.

## 3. Layout

- **Desktop (≥ 900px):** 224px left sidebar (logo, nav, Log a trip, settings at the foot). Content to the right with a page header (title, optional tabs, one primary action). The Ask panel docks as a 400px right column and pushes content.
- **Phone (< 900px):** no sidebar. A bottom tab bar with Map, Trips, Plan, Inbox and More (More opens a sheet with World, Ask, Settings). Page headers are compact. Sheets replace modals and side panels, rising from the bottom with a drag handle.
- Content pages have a max width of 1080px and use 24px padding on desktop, 16px on phone.
- Map is full-bleed under its own floating controls.

## 4. Visual system

Defined once in `src/styles/tokens.css` as CSS variables, with light and dark sets. Dark applies via `html[data-theme="dark"]`, or via `prefers-color-scheme` when the theme is "system".

- **Type:** `Inter` (Google Fonts), falling back to system-ui. Scale: 12 / 14 (body) / 16 / 20 / 28. Weights 400, 500 and 600. Tabular numerals for prices, dates and scores. No serif, and no mono except in code and IATA codes.
- **Color:** neutral grays plus one accent.
  - Light: bg `#f7f7f5`, surface `#ffffff`, text `#18181b`, muted `#71717a`, border `#e4e4e7`, accent `#2563eb`.
  - Dark: bg `#0f1115`, surface `#171a21`, text `#f4f4f5`, muted `#a1a1aa`, border `#27272a`, accent `#60a5fa`.
  - Semantic: success `#16a34a`, warning `#d97706`, danger `#dc2626`.
  - Trip colors come from the existing palette in `lib/tripColors` but are shown only as small dots and route lines.
  - Data scales (heatmap, replay grid) use one sequential ramp built from the accent, plus a diverging ramp for deltas.
- **Shape:** radius 8px on controls and 12px on cards and sheets. 1px borders. One soft shadow token, used only for floating layers (sheets, popovers, map controls).
- **Spacing:** 4px base; use 4, 8, 12, 16, 24, 32 and 48.
- **Motion:** 150ms ease-out for hovers, 200ms for sheets. Respect `prefers-reduced-motion`.
- **Icons:** one inline SVG set in `src/ui/icons.tsx`, 20px with 1.75 stroke. Lucide-style shapes drawn by hand; no icon dependency.

## 5. Primitives (`src/ui/`)

Each screen uses these and nothing else for chrome: `Button` (primary / secondary / ghost / danger; sm / md), `IconButton`, `Card`, `Tabs` (underline style for page tabs), `Segmented`, `Sheet` (bottom on phone, side or centered on desktop), `Dialog`, `Popover`, `Field` (label, hint, error), `Input`, `Textarea`, `Select`, `Badge`, `Chip`, `EmptyState` (icon, one line, one action), `Spinner`, `Skeleton`, `PageHeader` (title, tabs, actions), `Stat`, `Toast` (via a tiny store), `CitySearch` (combobox over loaded cities) and `UnlockCard` (journal token entry, shown inline wherever a gated feature is empty because of no token).

## 6. Screens

**Map.** A MapLibre flat (mercator) map, light or dark style, with deck.gl overlays: past journey arcs (2px, legible, colored by year), planned trip routes (trip color, dashed until confirmed), and city dots sized by population at higher zoom. A floating layer menu at the top right offers Past trips, Planned trips, Cities, and Seasons tint for a picked month. A floating "Log a trip" button sits at the bottom right. Tapping a city opens the **city panel** (right sheet on desktop, bottom sheet on phone) with its name and country, the best months strip from seasonality, region metrics, recent news for the region, your past visits, and actions: Add to trip, Log a visit, Watch prices, Book a flight, Ask about this place. There is no stray text on the map.

**Trips › Upcoming.** Cards for planned trips: color dot, name, status badge, stop chain ("Lisbon → Porto → Madrid"), dates or day count, estimated cost, and booked-leg count. Primary action: New trip. Agent candidates show in a "Suggested" row above the trips with Keep and Dismiss. The trip editor has the stop list (drag to reorder, remove), add stop via CitySearch, legs between stops with time and cost estimate, a "Book" button per leg that opens the booking sheet, and status as a Segmented control (Draft / Scouting / Confirmed).

**Trips › Past.** Stats row (trips, countries, nights, spent). Filters: year and a tag chip row. A timeline grouped by year with one row per journey: dates, title, stop chain, nights, rating. Primary action: Log a trip. Journey detail shows the header (title, dates, edit) and the stops list with conditions per stop (weather observed vs normal, crowds, fingerprint, with pending states in plain words). Segments and experiences are collapsible. The footer has "Repeat this trip" and "Watch similar".

**Quick-log sheet.** One column: title, then stops (CitySearch plus dates), rating and an optional note. Advanced fields (segments, costs, tags) sit under a "More details" disclosure. It saves with one button.

**Plan › When to go.** The seasons heatmap redrawn in the new ramp. Rows are cities or regions and columns are months, with a search box and a region filter. Hovering or tapping a cell gives a small popover.

**Plan › Repeat a trip.** Pick a journey and stop (or come from a journey), adjust the controls (bend, month range, budget) in a compact toolbar, then see the results list ("Places like Lisbon in October") with a match score, climate, crowds and price (MOCK badge when mock). The grid view is a secondary toggle.

**Plan › Watches.** A list of watches with rules in plain sentences and an Add watch sheet. The alerts feed sits above as cards with "View" (opens Repeat prefilled) and "Dismiss". A badge on Plan in the nav shows unseen alerts.

**Plan › Flights.** A search form (from, to, date, passengers) with offers listed below, then the passenger form, review and ticket flow in a Sheet. A "Your bookings" list sits underneath with cancel.

**Inbox.** An upload dropzone (email, Timeline JSON, photos) with a progress list. Clusters render as cards with their candidate rows, accept, merge into an existing journey (picker) or discard. The empty state reads "Nothing to review".

**World.** Two columns on desktop and stacked on phone: a news list (headline, source, region, time) with a region filter, and region metric cards. No auto-scrolling.

**Ask panel.** A chat thread, an input pinned at the bottom, and quick-prompt chips. City mentions render as chips that open the city panel. Replay matches render as compact result cards. Trip candidates render with Keep and Dismiss. Tools that need the token show the UnlockCard inline.

## 7. States

Every list has loading (Skeleton), empty (EmptyState with one action), error (one line plus Retry) and locked (UnlockCard) states. Mock data always carries a "Mock" badge. Pending computations read "Weather pending — checks again later", never a raw status.

## 8. Code layout

- `src/ui/`: primitives and icons.
- `src/shell/`: AppShell, Sidebar, TabBar, MoreSheet, SettingsPopover and router glue.
- `src/screens/map/`, `src/screens/trips/`, `src/screens/plan/`, `src/screens/inbox/`, `src/screens/world/` and `src/screens/ask/`.
- `src/styles/tokens.css` and `src/styles/base.css`. Screen CSS lives next to the screen as `*.css` using tokens only, with no hard-coded colors.
- The old `src/components/**`, `src/pages/**`, `src/styles/{booking,journal,seasonality}.css` and old `index.css` rules are deleted once nothing imports them. Tailwind is removed if nothing uses it.
- `src/lib/*` logic and its tests stay. Update a test only when a lib function's contract deliberately changes.
