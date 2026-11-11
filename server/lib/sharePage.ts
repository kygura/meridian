// The read-only page behind a trip's share link (ADR 0010). Plain server-rendered HTML:
// no scripts, no app shell, nothing fetched from anywhere, so it opens on any phone and
// leaks nothing to third parties. Everything on it comes from a SharedTrip, which is
// built from a stripped copy of the trip (src/lib/tripShare.ts).

import type { DayGroup, DayItem } from "../../src/lib/itinerary.js";
import { formatDay, nightsText } from "../../src/lib/itinerary.js";
import { MODE_LABEL } from "../../src/lib/legs.js";
import type { SharedLeg, SharedTrip } from "../../src/lib/tripShare.js";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const e = escapeHtml;

// Colours and type follow src/styles/tokens.css (parchment and ink by day, navy at night).
const CSS = `
:root{--bg:#f4ecd8;--surface:#fbf5e6;--ink:#1c1814;--muted:#6b624f;--border:rgba(28,24,20,.16);--accent:#9a4f06;--ok:#2a722d;--soft:rgba(42,114,45,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--surface:#161c2b;--ink:#ece6d8;--muted:#a39c8a;--border:rgba(236,230,216,.18);--accent:#f0a24a;--ok:#7fc883;--soft:rgba(127,200,131,.14)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
.kicker{font:11px/1.2 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
h1{font:400 34px/1.15 Georgia,"Times New Roman",serif;margin:0 0 4px;overflow-wrap:anywhere}
.sub{color:var(--muted);margin:0 0 24px}
h2{font:11px/1.2 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:32px 0 8px;font-weight:500}
.card{background:var(--surface);border:1px solid var(--ink);padding:4px 16px}
ol,ul{list-style:none;margin:0;padding:0}
.row{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
.row:first-child{border-top:0}
.when{flex:0 0 96px;color:var(--muted);font-variant-numeric:tabular-nums}
.what{flex:1;min-width:0;overflow-wrap:anywhere}
.name{font-weight:600}
.meta{color:var(--muted);display:block}
.tag{display:inline-block;font-size:12px;padding:0 6px;border:1px solid var(--border);color:var(--muted);margin-left:6px;white-space:nowrap}
.tag.ok{color:var(--ok);background:var(--soft);border-color:transparent}
.item{display:flex;gap:8px;padding:2px 0}
.time{flex:0 0 44px;color:var(--muted);font-variant-numeric:tabular-nums}
footer{margin-top:32px;color:var(--muted);font-size:13px}
@media (max-width:480px){.row{flex-direction:column;gap:2px}.when{flex:none}h1{font-size:28px}}
`;

function clock(local: string | undefined): string {
  return local ? local.slice(11, 16) : "";
}

function legLine(l: SharedLeg): string {
  const what = [l.carrier, l.number].filter(Boolean).join(" ");
  const times = l.departAt
    ? `${clock(l.departAt)}${l.arriveAt ? ` to ${clock(l.arriveAt)}${l.arriveAt.slice(0, 10) !== l.departAt.slice(0, 10) ? ` (${formatDay(l.arriveAt.slice(0, 10), { year: false })})` : ""}` : ""}, local times`
    : "";
  return `<li class="row">
    <span class="when">${l.date ? e(formatDay(l.date, { year: false })) : "Date not set"}</span>
    <span class="what"><span class="name">${e(l.from)} to ${e(l.to)}</span>
      <span class="tag">${e(MODE_LABEL[l.mode])}</span>${l.booked ? `<span class="tag ok">Booked</span>` : ""}
      ${what || times ? `<span class="meta">${e([what, times].filter(Boolean).join(" · "))}</span>` : ""}
    </span>
  </li>`;
}

function dayItem(i: DayItem): string {
  return `<li class="item"><span class="time">${e(i.time ?? "")}</span><span>${e(i.title)}${i.detail ? `<span class="meta">${e(i.detail)}</span>` : ""}</span></li>`;
}

function dayRow(g: DayGroup): string {
  const when =
    g.days === 1
      ? formatDay(g.from, { year: false })
      : `${formatDay(g.from, { weekday: false, year: false })} to ${formatDay(g.to, { weekday: false, year: false })}`;
  const where = g.places.length ? g.places.join(" and ") : "On the way";
  return `<li class="row">
    <span class="when">${e(when)}</span>
    <span class="what"><span class="name">${e(where)}</span>${g.days > 1 ? `<span class="meta">${g.days} days</span>` : ""}
      ${g.items.length ? `<ul>${g.items.map(dayItem).join("")}</ul>` : ""}
    </span>
  </li>`;
}

export function renderSharePage(t: SharedTrip): string {
  const stops = t.stops
    .map((s) => {
      const when =
        s.arrive && s.depart
          ? `${formatDay(s.arrive, { weekday: false, year: false })} to ${formatDay(s.depart, { weekday: false })}`
          : s.arrive || s.depart
            ? formatDay((s.arrive ?? s.depart)!, { weekday: false })
            : (s.months ?? "Not placed yet");
      const meta = [
        s.nights !== undefined ? nightsText(s.nights) : "",
        s.stay ? `Staying at ${s.stay.name}${s.stay.address ? `, ${s.stay.address}` : ""}` : "",
      ].filter(Boolean);
      return `<li class="row"><span class="when">${e(when)}</span><span class="what"><span class="name">${e(s.name)}</span>${meta.length ? `<span class="meta">${e(meta.join(" · "))}</span>` : ""}</span></li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${e(t.name)} · shared itinerary</title>
<style>${CSS}</style>
</head>
<body>
<main>
<p class="kicker">Shared itinerary · read only</p>
<h1>${e(t.name)}</h1>
<p class="sub">${e([t.when, `from ${t.from}`].filter(Boolean).join(" · "))}</p>

<h2>Stops</h2>
<div class="card">${t.stops.length ? `<ol>${stops}</ol>` : `<p>No stops yet.</p>`}</div>

${t.legs.length ? `<h2>Getting around</h2><div class="card"><ol>${t.legs.map(legLine).join("")}</ol></div>` : ""}

${t.days.length ? `<h2>Day by day</h2><div class="card"><ol>${t.days.map(dayRow).join("")}</ol></div>` : ""}

<footer>Times are local to each place. This page shows the plan only: no booking references, prices or traveller details.</footer>
</main>
</body>
</html>`;
}

export function renderShareGone(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Link not available</title><style>${CSS}</style></head>
<body><main><p class="kicker">Shared itinerary</p><h1>This link isn't available</h1>
<p class="sub">It may have been turned off, or the trip was deleted. Ask whoever sent it for a new one.</p></main></body></html>`;
}
