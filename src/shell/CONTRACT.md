# Meridian v3 UI contract

This is the contract for the screen agents. `DESIGN-v3.md` is the brief. This file covers
how the pieces fit: who owns which files, the props each mount point receives, shared
state, primitives and conventions. Don't change anything under "Shared" without
coordinating with the other agents. If you need a new primitive, build it inside your
own directory, or ask for it.

## 1. File ownership

| Path | Owner | Notes |
|---|---|---|
| `src/styles/tokens.css`, `src/styles/base.css` | shared (foundation) | Colours are defined only here. |
| `src/ui/**` | shared (foundation) | Primitives, icons, toast, layers, palette, journal token hook. |
| `src/shell/**` | shared (foundation) | AppShell, Sidebar, TabBar/MoreSheet, SettingsPanel, theme, uiStore, nav badges, keys. |
| `src/lib/router.ts` | shared (foundation) | Routes, `navigate`, `hrefFor`. |
| `src/App.tsx`, `src/main.tsx`, `index.html` | shared (foundation) | Mounting only. |
| `src/screens/map/**` | map agent | `MapScreen.tsx`, `CityPanel.tsx`, `map.css`. |
| `src/screens/trips/TripsScreen.tsx`, `trips.css` | foundation | Header + Upcoming/Past switch. Trips agents may add `.trips-*` rules to their own css files. |
| `src/screens/trips/upcoming/**` | trips/upcoming agent | `UpcomingList.tsx`, `TripEditor.tsx`. |
| `src/screens/trips/past/**` | trips/past agent | `PastTimeline.tsx`, `JourneyDetail.tsx`, `QuickLogSheet.tsx`. |
| `src/screens/plan/PlanScreen.tsx`, `plan.css` | foundation | Header + tabs. |
| `src/screens/plan/when/**`, `repeat/**`, `watches/**`, `flights/**` | plan agent(s) | `flights/BookingSheet.tsx` is global. |
| `src/screens/inbox/**` | inbox agent | |
| `src/screens/world/**` | world agent | |
| `src/screens/ask/**` | ask agent | `AskPanel.tsx`. |

`src/lib/*` logic, `src/types.ts`, `src/store.ts` and `server/**` stay as they are. The old
`src/components/**`, `src/pages/**`, `src/index.css` and the old booking/journal/seasonality
stylesheets have been deleted, and Tailwind is no longer used (no config, no PostCSS plugin).

Put screen CSS next to the screen as `*.css` and import it from the component. Add helper
components and hooks inside your own directory. Add subfolders when you need them.

## 2. Mount points and props

Every stub default-exports its component. Keep the file path, the default export and the
props as listed.

| Component | Props | Mounted by / when |
|---|---|---|
| `screens/map/MapScreen` | `{ active: boolean }` | App, **always mounted**. Its wrapper gets the `hidden` attribute (display:none) when you leave the map. Call `map.resize()` when `active` becomes true. Full-bleed: no `Page` wrapper. |
| `screens/map/CityPanel` | `{ cityId: string; onClose: () => void }` | App, globally, while `useUIStore.cityPanel` is set (any route). Use `<Sheet modal={false}>`. It remounts for each city (keyed by cityId). |
| `screens/trips/TripsScreen` | `{ route: Extract<Route,{view:"trips"}> }` | App on `#/trips…`. |
| `screens/trips/upcoming/UpcomingList` | none | TripsScreen, `#/trips`. |
| `screens/trips/upcoming/TripEditor` | `{ tripId: string }` | TripsScreen, `#/trips/plan/<tripId>`, inside `<Page>`, keyed by tripId. |
| `screens/trips/past/PastTimeline` | none | TripsScreen, `#/trips/past`. |
| `screens/trips/past/JourneyDetail` | `{ journeyId: string }` | TripsScreen, `#/trips/past/<journeyId>`, inside `<Page>`, keyed by journeyId. |
| `screens/trips/past/QuickLogSheet` | none | App, always mounted. Reads `useMeridianStore.quickLog`. |
| `screens/plan/PlanScreen` | `{ route: Extract<Route,{view:"plan"}> }` | App on `#/plan…`. |
| `screens/plan/when/WhenToGo` | none | PlanScreen, `#/plan/when`. Shared default page width (1080px), like the other tabs. |
| `screens/plan/repeat/RepeatTrip` | `{ journeyId?: string; stopIndex?: number }` | PlanScreen, `#/plan/repeat[/<journeyId>[/<stopIndex>]]`, keyed by seed. `stopIndex` is 0-based. |
| `screens/plan/watches/Watches` | none | PlanScreen, `#/plan/watches`. |
| `screens/plan/flights/Flights` | none | PlanScreen, `#/plan/flights`. |
| `screens/plan/flights/BookingSheet` | none | App, always mounted. Reads `useMeridianStore.bookingModal`. |
| `screens/inbox/InboxScreen` | none | App on `#/inbox`. |
| `screens/world/WorldScreen` | none | App on `#/world`. |
| `screens/ask/AskPanel` | `{ mode: "docked" \| "sheet"; onClose: () => void }` | AppShell, only while `useUIStore.ask.open`. In `docked` mode (≥ 900px) the panel fills a 400px right column and draws its own header with a close button. In `sheet` mode (phone), wrap the content in `<Sheet open onClose={onClose} title="Ask">`. |

Every routed screen sits inside `.shell-screen` (`position:absolute; inset:0; overflow:hidden`).
Content screens use `<Page>`, which provides scrolling, the 1080px max width and 24px/16px
padding.

## 3. Routes (`src/lib/router.ts`)

```ts
type Route =
  | { view: "map" }
  | { view: "trips"; tab: "upcoming" | "past"; tripId?: string; journeyId?: string }
  | { view: "plan"; tab: "when" | "repeat" | "watches" | "flights"; journeyId?: string; stopIndex?: number }
  | { view: "inbox" }
  | { view: "world" };
parseHash(hash): Route          // legacy hashes map to their new route
routePath(route): string        // "/trips/past/j1"
hrefFor(route): string          // "#/trips/past/j1" (for <a href>)
navigate(pathOrRoute): void     // navigate("/plan/watches") or navigate({ view: "plan", tab: "watches" })
useRoute(): Route               // also swaps a legacy hash for the canonical one (replaceState)
```

Canonical hashes:

| Hash | Screen |
|---|---|
| `#/` | map |
| `#/trips` | upcoming trips |
| `#/trips/past` | past trips |
| `#/trips/plan/<tripId>` | trip editor |
| `#/trips/past/<journeyId>` | journey detail |
| `#/plan/when` | When to go |
| `#/plan/repeat` | Repeat a trip |
| `#/plan/repeat/<journeyId>[/<stopIndex>]` | Repeat a trip, seeded from a journey |
| `#/plan/watches` | Watches |
| `#/plan/flights` | Flights |
| `#/inbox` | inbox |
| `#/world` | world |

These legacy hashes redirect: `#/journal`, `#/journal/<id>`, `#/journal/inbox`,
`#/journal/replay/...`, `#/seasons` and `#/trips/<id>`. Use `<a href={hrefFor(...)}>` for
navigation links and `navigate()` after an action.

## 4. Page anatomy, headers and primary actions

Every content page stacks the same parts in the same order. Leave out what a page doesn't
need, but don't reorder or restyle them:

1. **Back link** (detail views only), top left.
2. **Kicker**, one mono line.
3. **Title row**: the serif title on the left, the page's header actions on the right,
   centred on the title. At most one primary (filled) button, and it lives here.
4. **Subtitle** (optional), one muted line.
5. **Section tabs**: underline `Tabs` with `href`s (route tabs). Trips and Plan both use
   them. `Segmented` is for switching a view *inside* a section (list/grid, your
   cities/all countries, trip status), never for page sections.
6. **Toolbar** (optional): search on the left, filters and sort on the right; wraps on phone.
7. **Sections**, each opened by `<SectionHeader title meta? actions? />`: a mono label,
   a muted meta (count or summary) and small ghost/icon actions on the right. Section
   headings never use the serif; that belongs to page, sheet and empty-state titles.

**Sheets and side panels** (city panel, quick log, booking, watches, filters, the docked
Ask column) follow the same order inside `<Sheet>`: the sheet header is the title row (serif
title, description as the subtitle, close and `headerExtra` on the right), then sections
opened by `<SectionHeader level={3}>`. Inside a sheet the section heading carries a hairline
rule, because sheet sections stack without cards. A heading *inside a card* (trip editor
cards, booking review) is a plain `<h3 className="ui-section-title">`, with no rule. The
docked Ask column reuses `.ui-sheet-header` / `.ui-sheet-title` so it matches.

Global actions: "Log a trip" sits in the sidebar as a secondary button on desktop (so the
page's own primary stays the only filled button), and as the Map's floating button on phones
only.


- **Trips list and Plan:** the foundation screen renders `<Page>`, `<PageHeader>` and the
  route Tabs, all inside `<PageActionsProvider>`. Your tab component renders
  only its content. To put your one primary action in the header, render it like this:
  ```tsx
  <PageActions><Button variant="primary" icon={<IconPlus />}>New trip</Button></PageActions>
  ```
  The action portals into the header and goes away when your tab unmounts.
  - UpcomingList shows **New trip**.
  - PastTimeline shows **Log a trip**, which calls `openQuickLog()`. No `<Fab>` here: on phones the FAB is on the Map only.
  - Watches shows **Add watch**.
  - When to go, Repeat a trip and Flights have no header action unless one is needed.
- **Detail views** (TripEditor, JourneyDetail): you render your own
  `<PageHeader title back={{ label: "Trips", href: "#/trips" }} actions={…} />`. Use
  "Past trips" with `#/trips/past` for JourneyDetail. TripsScreen only wraps you in `<Page>`.
- **Inbox, World:** render `<Page><PageHeader title="Inbox" actions={…} />…</Page>` yourself.
- **Map:** no page header. Floating controls only.
- Mark a screen's main search input with `data-page-search`. The "/" key focuses it.

## 5. Opening global layers from anywhere

```ts
import { useUIStore, openCity, openAsk } from "../shell/uiStore";   // adjust the relative path
import { useMeridianStore } from "../store";

openCity(cityId)                               // city panel (any route)
useUIStore.getState().closeCity()
openAsk("What's Lisbon like in October?")      // opens Ask with the input prefilled (not sent)
useUIStore.getState().toggleAsk()              // ⌘K does this too
useMeridianStore.getState().openQuickLog()                                 // Log a trip
useMeridianStore.getState().openQuickLog({ journeyId })                    // edit an existing journey
useMeridianStore.getState().openQuickLog({ prefillStops: [cityId, ...] })  // log a visit from the city panel
useMeridianStore.getState().openBookingModal({ dest, origin?, tripId?, legIndex?, departureDateHint? }) // BookingTarget
toast("Trip saved") / toast("Couldn't save", { tone: "danger", action: { label: "Retry", onClick } })
```

### `uiStore` API (`src/shell/uiStore.ts`)

```ts
cityPanel: { cityId: string } | null;  openCity(id); closeCity();
ask: { open: boolean; prefill?: string; nonce: number };
openAsk(prefill?); closeAsk(); toggleAsk(); consumeAskPrefill();
```

Ask: when `ask.prefill` is set (watch `nonce` too), copy it into your input, then call
`consumeAskPrefill()`.

## 6. `useMeridianStore` fields to use (`src/store.ts`)

| Need | Fields |
|---|---|
| Cities | `cities` (loaded by App), `shortlist`, `addToShortlist`, `removeFromShortlist` |
| Planned trips | `trips`, `createTrip(name?) → id`, `updateTripName`, `updateTripStatus`, `updateTripColor`, `addCityToTrip(tripId, node)`, `addCityToActiveTrip(node)`, `removeNodeAt`, `replaceNodeAt`, `reorderTripNodes(tripId, from, to)`, `duplicateTrip`, `removeTrip`, `activeTripId`, `setActiveTrip` |
| Agent trip candidates | `trips` with `origin === "agent"`, `setAgentCandidates(options)`, `confirmCandidate(id)` (Keep), `discardCandidate(id)` (Dismiss one), `discardAgentCandidates()` (Dismiss all) |
| Bookings | `bookings`, `fetchBookings()`, `applyBookingCancelled(id)`, `bookingModal {open,target}`, `openBookingModal(target)`, `closeBookingModal()` |
| Quick log | `quickLog {open, journeyId?, prefillStops?}`, `openQuickLog(opts?)`, `closeQuickLog()` |
| Journal | `journeys` (null = not loaded), `setJourneys`, `upsertJourney`, `removeJourney`. Load with `refreshJourneys()` from `lib/journalApi`. |
| Lock state | Use `useJournalToken()` (below) rather than reading `journalLocked` / `journalLockReason` directly. |
| Watches and alerts | `watches`, `setWatches`, `alerts`, `setAlerts`, `alertsUnseen` |
| Inbox count | `importPending`, `setImportPending` (`refreshQueue()` in journalApi updates it) |
| Repeat prefill | `replayPrefill {query, cityId, month}`, `setReplayPrefill`. An alert's "View" sets it and then calls `navigate("/plan/repeat")`. RepeatTrip applies it once, then clears it. |
| Seasonality cache | `seasonality`, `setSeasonality`, `mergeSeasonality`, `seasonalityRegions`, `setSeasonalityRegions`, `seasonsShowRegions`, `setSeasonsShowRegions` |
| City data caches | `surfaces`, `setSurface`, `ticker`/`setTicker` (news headlines, shared by World and the city panel) |
| Map layers | Not in this store: `useMapPrefs` in `src/shell/mapPrefs.ts` (`layers.past/planned/cities/seasons`, `setLayer`, `month`). Persisted per browser. |
| Watch prefill | `setWatchPrefill({ cityId })` (city panel) or `setWatchPrefill({ journeyId, stopIndex? })` (journey detail) from `src/lib/watchPrefill.ts`, then `navigate("/plan/watches")`. Watches opens "Add watch" with it. |

The old-UI fields (theme wipe, drawers, command palette, overlays, bookings/alerts panels,
draw mode, journal draw, journey scrub, globe layers, `selectedCityId`, candidate filters,
city metric/score caches) have been removed from the store. Persisted state is versioned
(v1): on load only `trips` and `activeTripId` are kept, and old "TRIP 3" / "X COPY" names are
reworded. For the city panel, use `uiStore.openCity`.

**Theme:** the theme lives in the shell, not in the store. Use
`import { useResolvedTheme } from "src/shell/theme"`, which returns `"light" | "dark"`.
`useThemeStore` holds `pref` (`"light" | "dark" | "system"`) and `setPref`. The shell writes
`html[data-theme]` and mirrors the resolved value into `useMeridianStore.theme`, which is
read-only for you.

Months are 1-based in the API. Journal, replay, import, watches and the agent's journal
tools all need the Bearer token. `lib/journalApi`'s `jfetch` attaches it, so always use the
typed calls there.

## 7. Journal token

```ts
import { useJournalToken, UnlockCard } from "src/ui";
const { token, unlocked, lockReason, setToken, clear } = useJournalToken();
useEffect(() => { if (unlocked) void load(); }, [token, unlocked]);   // refetch on unlock
if (!unlocked) return <UnlockCard />;                                  // locked state
```

`unlocked` is true when a token is saved and the server has not answered 401. `UnlockCard`
verifies the token, saves it, notifies every hook user and refreshes the nav badges.
`onJournalTokenChange(cb)` works outside React. The shell polls the inbox and alert badges
every 15 minutes, and only while a token exists. In screens, read the counts with
`useBadgeCounts()` from `src/shell/useNavBadges`.

## 8. Primitives (`import { … } from "src/ui"`)

| Primitive | Props |
|---|---|
| `Button` | `variant?: "primary"\|"secondary"\|"ghost"\|"danger"\|"danger-outline"` (default secondary), `size?: "sm"\|"md"`, `icon?`, `iconRight?`, `loading?`, `block?`, plus button attrs. Use one primary per screen. A destructive action that opens a confirm uses `danger-outline`; the filled `danger` is for the confirm button itself. |
| `IconButton` | `label` (required, aria-label + title), `icon`, `variant?: "ghost"\|"secondary"\|"primary"\|"danger"`, `size?`, `badge?` |
| `Fab` | `icon?`, `children`, button attrs. Absolutely positioned at the bottom-right of the nearest positioned ancestor. |
| `Card` | `interactive?`, `padding?: "none"\|"sm"\|"md"`, div attrs |
| `Stat` | `label`, `value`, `hint?` |
| `Badge` | `tone?: "neutral"\|"accent"\|"success"\|"warning"\|"danger"`, `appearance?: "soft"\|"solid"`. Mock data gets `<Badge tone="warning">Mock</Badge>`. |
| `Chip` | `selected?`, `onClick?` (toggle, aria-pressed), `onRemove?`, `icon?`, `disabled?` |
| `Tabs<T>` | `items: {value, label, badge?, href?}[]`, `value`, `onChange?`, `label`. Items with `href` render as nav links; otherwise they form an ARIA tablist. |
| `Segmented<T>` | `options: {value, label, icon?, disabled?}[]`, `value`, `onChange`, `label`, `size?`, `block?` |
| `Sheet` | `open`, `onClose`, `title`, `description?`, `desktop?: "side"\|"center"`, `size?: "sm"\|"md"\|"lg"`, `footer?`, `headerExtra?`, `modal?` (default true), `initialFocus?`. Bottom sheet below 900px with a drag handle. Esc closes it, focus is trapped and returned. |
| `Dialog` | `open`, `onClose`, `title`, `description?`, `footer?`, `role?: "dialog"\|"alertdialog"`, `initialFocus?`, `children?`. Use for confirmations only. |
| `Popover` | `open`, `onClose`, `anchorRef`, `placement?`, `label`, `role?`, `autoFocus?`. Closes on Esc or an outside click and returns focus to the anchor. |
| `Field` | `label`, `hint?`, `error?`, `hideLabel?`, `optional?`, `children` (exactly one control; ids and aria are wired automatically) |
| `Input` | `size?`, `icon?`, `ref?`, input attrs. `Textarea`: textarea attrs. `Select`: `options?: {value,label}[]` or `<option>` children, `size?` |
| `Disclosure` | `summary`, `children`, `defaultOpen?`. Use it for "More details". |
| `EmptyState` | `icon?`, `title` (one line), `description?`, `action?`, `size?: "page"\|"inline"` |
| `ErrorState` | `message?`, `onRetry?`. One line plus a Retry button. |
| `Spinner` | `size?`, `label?`. `Skeleton`: `width?`, `height?`, `radius?`, `lines?` |
| `PageHeader` | `kicker?` (small mono line above the title), `title` (Instrument Serif), `subtitle?`, `back?: {label, href?, onClick?}`, `tabs?`, `actions?` |
| `PageActions` / `PageActionsProvider` | the header action slot (section 4) |
| `SectionHeader` | `title`, `id?` (for `aria-labelledby`), `meta?`, `actions?`, `level?: 2\|3`. The only section heading (section 4). Inside a card, `className="ui-section-title"` on a plain heading gives the same label. |
| `Page` | `width?: "default"\|"wide"`. The scroll container for content pages. |
| `toast(msg, {tone?, action?, duration?})` | App mounts `<Toaster/>`. Don't mount another one. |
| `CitySearch` | `onPick(city)`, `placeholder?`, `aria-label?`, `id?`, `autoFocus?`, `excludeIds?`, `cities?`, `clearOnPick?` (default true), `defaultValue?`, `size?`, `limit?`, `disabled?`, `inputRef?`. Airport cities rank first. Can go inside `<Field>`. `searchCities(cities, q, limit?, excludeSet?)` is the pure function behind it. |
| `UnlockCard` | `onUnlocked?`, `title?`, `compact?` |
| Hooks | `useJournalToken()`, `useIsDesktop()`, `useMediaQuery(q)`, `useLayer(open, onClose)` (register a custom Esc-closable layer), `useFocusTrap(ref, active)` |
| Canvas colours | `usePalette().get("--accent")`, `readToken(name)`, `toRgba(color, alpha?)` → deck.gl `[r,g,b,a]`, `RAMP_VARS`, `DIVERGING_VARS`, `rampStep(t)` |
| Icons | `Icon*` from `src/ui/icons`: Map, Trips, Plan, Inbox, World, Ask, Plus, Minus, Copy, Search, Close, ChevronDown/Up/Left/Right, Settings, Sun, Moon, Monitor, Calendar, Pin, Plane, Bell, Upload, Check, Trash, Edit, Drag, More, Lock, Unlock, Star, External, Filter, ArrowRight, ArrowLeft, Refresh, Layers, Info, Alert, Eye, EyeOff, Sparkle, Menu, Send, Clock, Logo. Props are `size?` (default 20) and `title?` (gives the icon an accessible name). Icons are decorative by default. |

Esc always closes the topmost layer (Sheet, Dialog, Popover or the Ask panel), through
`src/ui/layers.ts`. If one of your handlers needs Esc for itself, for example to close an
open list inside a sheet, call `e.preventDefault()` on it.

## 9. CSS conventions

- The look is the original Meridian "modern atlas": parchment `--bg`, paper `--surface`, ink
  `--text`/`--ink`, burnt-orange `--accent`; dark is "night ops" navy with an ember (orange) offset shadow.
  Orange is the only accent. Green is status only (success, best window, the good end of ramps).
  Ink hairline frames, square corners, hard offset shadows (no blur), a grain overlay
  (`body::after`, `--grain-op`).
- Use tokens only: `var(--bg|--surface|--surface-2|--surface-3|--text|--ink|--ink-2|--muted|--subtle|--border|--border-strong|--rule|--accent|--accent-hover|--accent-soft|--accent-text|--on-accent|--success|--warning|--danger|--info|*-soft|--shadow|--shadow-sm|--shadow-lg|--scrim)`.
  `--border` is a hairline, `--border-strong` a stronger hairline, `--rule` the ink frame used for
  floating layers and selected cards (with `--shadow`).
  - Spacing: `--space-1..7` (4, 8, 12, 16, 24, 32, 48).
  - Type: `--font-sans` (DM Sans, body), `--font-display` (Instrument Serif italic: page,
    sheet and section display titles), `--font-mono` (JetBrains Mono: labels, numbers, metadata).
    Sizes `--text-2xs|xs|sm|md|lg|xl` (10/12/14/16/20/34), `--weight-regular|medium|semibold`,
    `--label-tracking` / `--kicker-tracking` for uppercase mono labels. Utility classes:
    `.kicker` / `.mono-label`, `.display`.
  - Radius: square. `--radius-control` / `--radius-card` (0), `--radius-sm` / `--radius-pill` (2).
  - Motion: `--dur-fast` and `--dur-sheet` with `--ease`.
  - Ramps: `--ramp-0..6` (the original warm straw-to-sienna heat ramp; ember-to-gold in dark) with `--ramp-text-dark|light`, `--ramp-best`, `--div-neg-3..--div-pos-3` (red to green).
  - Map: `--map-land|water|border|label|arc|dot`, plus the original globe tokens `--land|--ocean|--grat|--equator|--border-country|--air-route|--trip-a|b|c`.
  - Layers: `--z-map-controls|nav|panel|sheet|popover|toast`.
  - Never hard-code a colour in screen CSS.
- Class prefix per screen: `.map-*`, `.trips-*`, `.plan-*` (or `.plan-when-*`, `.plan-repeat-*`, `.plan-watches-*`, `.plan-flights-*`), `.inbox-*`, `.world-*`, `.ask-*`. `.ui-*` and `.shell-*` are reserved.
- Breakpoint: `@media (max-width: 899.98px)` for phone and `(min-width: 900px)` for desktop. In JS, use `useIsDesktop()`. Touch targets are at least 44px on phones (`--touch`).
- Use `.num` / `.tabular` for prices, dates and scores, and `.iata` for airport codes. Use `.sr-only` for visually hidden text.
- Copy is written in plain sentence case in the source. Small labels, kickers, tabs, nav and
  buttons are rendered as uppercase mono by CSS (`text-transform`), as in the original. No
  internal field names.
- Trip colours come from `lib/tripColors` (`resolveTripColor`). Show them only as small dots and route lines.
- Pending states use plain words, for example "Weather pending — checks again later".
