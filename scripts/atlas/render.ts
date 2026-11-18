// Plain-text summaries of Meridian responses for the terminal.

import type {
  AtlasPlace,
  AtlasSignal,
  ConfigResponse,
  ContextResponse,
  DiscoveryResponse,
  FaresResponse,
  HealthResponse,
  ImportResponse,
  NotifyResponse,
  OriginSource,
  RunSummary,
  RunsResponse,
  ScanResponse,
  SeasonalResponse,
  SignalsAddResponse,
  StaySummary,
  TripResponse,
  WishlistUpsertResponse
} from "./client";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthName(n: number): string {
  return MONTHS[n - 1] ?? String(n);
}

export function monthList(months: number[]): string {
  return months.length ? months.map(monthName).join(", ") : "none";
}

export function eur(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : `${Math.round(n)} EUR`;
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  const v = Math.round(n * 10) / 10;
  return `${v > 0 ? "+" : ""}${v}%`;
}

function score(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : (Math.round(n * 100) / 100).toFixed(2);
}

/** Left-aligned columns separated by two spaces. */
export function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const ORIGIN_SOURCE: Record<OriginSource, string> = {
  "rotation-current": "the rotation's current location",
  "rotation-next": "the next stay in the rotation",
  "rotation-home": "the rotation's home",
  fallback: "the fallback airports"
};

function stay(label: string, s: StaySummary | null): string {
  if (!s) return `${label}: none`;
  const dates = s.start || s.end ? ` (${s.start ?? "?"} to ${s.end ?? "?"})` : "";
  return `${label}: ${s.name}${s.country ? `, ${s.country}` : ""}${s.iata ? ` [${s.iata}]` : ""}${dates}, ${s.status}`;
}

function watchLabel(p: AtlasPlace): string {
  if (!p.watch) return "";
  const b = p.watch.targetBudgetEur;
  const budget = b ? (b.min !== undefined && b.max !== undefined ? ` ${b.min}-${b.max} EUR` : b.max !== undefined ? ` under ${b.max} EUR` : b.min !== undefined ? ` over ${b.min} EUR` : "") : "";
  return `${p.watch.active ? "watching" : "watch off"}${budget}`;
}

export function renderRunLine(r: RunSummary): string {
  const counts = Object.entries(r.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const top = r.top ? `, top ${r.top.destination} ${eur(r.top.priceEur)} (${score(r.top.composite)})` : "";
  const passed = r.passed && r.passed.length ? `, passed: ${r.passed.join(", ")}` : "";
  const fire = r.kind === "fire" ? `  ${r.status ?? "fired"}${r.detail ? `: ${r.detail}` : ""}` : "";
  return `${r.at}  ${r.kind}/${r.mode}  from ${r.origin ?? "n/a"}  ${counts}${top}${passed}${fire}  [${r.id}]`.replace(/ {2,}\[/, "  [");
}

export function renderHealth(h: HealthResponse): string {
  const status = typeof h.status === "string" ? h.status : typeof h.ok === "boolean" ? (h.ok ? "ok" : "not ok") : "ok";
  return `Meridian: ${status}`;
}

export function renderStatus(health: HealthResponse, ctx: ContextResponse, baseUrl: string): string {
  const lines = [
    `${renderHealth(health)} (${baseUrl})`,
    `Origin: ${ctx.origin.name}${ctx.origin.iata ? ` [${ctx.origin.iata}]` : ""}, from ${ORIGIN_SOURCE[ctx.origin.source]}`,
    `Wishlist: ${ctx.wishlist.length} places (${ctx.wishlist.filter((p) => p.watch?.active).length} watched)`,
    ctx.lastRuns[0] ? `Last run: ${renderRunLine(ctx.lastRuns[0])}` : "Last run: none"
  ];
  return lines.join("\n");
}

export function renderContext(ctx: ContextResponse): string {
  const out: string[] = [];
  out.push(`Today: ${ctx.today}`);
  out.push(
    `Origin: ${ctx.origin.name}, ${ctx.origin.country}${ctx.origin.iata ? ` [${ctx.origin.iata}]` : ""} (${ctx.origin.source}: ${ORIGIN_SOURCE[ctx.origin.source]})`
  );
  out.push(`Fallback origins: ${ctx.fallbackOrigins.join(", ") || "none"}`);
  out.push("");
  out.push("Rotation");
  out.push(`  ${stay("Current", ctx.rotation.current)}`);
  out.push(`  ${stay("Next", ctx.rotation.next)}`);
  out.push(`  Days left in current stay: ${ctx.rotation.daysLeft ?? "n/a"}`);
  out.push(`  Next move: ${ctx.rotation.nextMoveDate ?? "n/a"}`);
  out.push("");
  out.push("Search windows");
  out.push(`  A: ${ctx.windows.a.from} to ${ctx.windows.a.to}`);
  out.push(`  B: ${ctx.windows.b.from} to ${ctx.windows.b.to}`);
  out.push("");
  out.push(`Wishlist (${ctx.wishlist.length})`);
  if (ctx.wishlist.length === 0) {
    out.push("  empty");
  } else {
    out.push(
      table(
        ["place", "iata", "source", "priority", "best months", "avoid now", "watch"],
        ctx.wishlist.map((p) => [
          p.name,
          p.iata ?? "",
          p.source,
          String(p.priority),
          monthList(p.season.bestMonths),
          p.season.avoidNow ? "yes" : "no",
          watchLabel(p)
        ])
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
  }
  out.push("");
  out.push(`Trip ideas (${ctx.ideas.length})`);
  for (const w of ["a", "b"] as const) {
    const top = ctx.ideas.filter((i) => i.window === w).slice(0, 3);
    if (top.length) out.push(`  ${w.toUpperCase()}: ${top.map((i) => `${i.name} ${score(i.score)}`).join(", ")}`);
  }
  if (ctx.ideas.length === 0) out.push("  none");
  out.push("  Run 'ideas' for the reasons.");
  out.push("");
  out.push(`Research needed (${ctx.researchNeeded.length})`);
  const need = ctx.researchNeeded.slice(0, 5).map((r) => `${r.name} (${r.months.map(monthName).join(", ")})`);
  out.push(`  ${need.length ? need.join("; ") : "none"}${ctx.researchNeeded.length > 5 ? `; and ${ctx.researchNeeded.length - 5} more` : ""}`);
  out.push(`Routine trigger: ${ctx.routine.configured ? "configured" : "not configured"}`);
  out.push("");
  out.push(`Recently scouted (${ctx.recentlyScouted.length})`);
  for (const r of ctx.recentlyScouted) out.push(`  ${r.name}${r.iata ? ` [${r.iata}]` : ""}  ${r.at}`);
  if (ctx.recentlyScouted.length === 0) out.push("  none");
  out.push("");
  out.push(`Recent runs (${ctx.lastRuns.length})`);
  for (const r of ctx.lastRuns) out.push(`  ${renderRunLine(r)}`);
  if (ctx.lastRuns.length === 0) out.push("  none");
  return out.join("\n");
}

export function renderSeasonal(res: SeasonalResponse): string {
  const head = `Months: ${monthList(res.months)}${res.vibes.length ? `; vibes: ${res.vibes.join(", ")}` : ""}`;
  if (res.cities.length === 0) return `${head}\nNo cities matched.`;
  return `${head}\n${table(
    ["city", "country", "iata", "comfort", "crowd", "strength", "role", "score"],
    res.cities.map((c) => [
      c.name,
      c.country,
      c.iata,
      score(c.comfort),
      c.crowd === null ? "n/a" : score(c.crowd),
      c.strength === null ? "n/a" : score(c.strength),
      c.role ?? "",
      score(c.score)
    ])
  )}`;
}

export function renderConfig(res: ConfigResponse): string {
  return `Config updated: ${res.updatedAt ?? "never (defaults)"}\n${JSON.stringify(res.config, null, 2)}`;
}

export function renderWishlist(entries: AtlasPlace[]): string {
  if (entries.length === 0) return "Wishlist is empty.";
  return table(
    ["cityId", "place", "iata", "source", "priority", "tags", "avoid", "watch"],
    entries.map((p) => [
      p.cityId,
      `${p.name}, ${p.country}`,
      p.iata ?? "",
      p.source,
      String(p.priority ?? 3),
      p.intentTags.join(","),
      p.avoidMonths.map(monthName).join(","),
      watchLabel(p)
    ])
  );
}

export function renderWishlistUpsert(res: WishlistUpsertResponse): string {
  const out: string[] = [];
  if (res.entries.length) out.push(`Saved ${res.entries.length} place${res.entries.length === 1 ? "" : "s"}:`, renderWishlist(res.entries));
  for (const u of res.unresolved) {
    const p = u.place;
    const name = "cityId" in p ? p.cityId : "iata" in p ? p.iata : p.query;
    out.push(`Not resolved: ${name} (${u.reason})`);
  }
  return out.join("\n");
}

export function renderScan(res: ScanResponse): string {
  const out: string[] = [];
  out.push(`Scan run ${res.runId}: ${res.scored.length} scored, ${res.rejected.length} rejected`);
  if (res.scored.length) {
    out.push("");
    const ranked = [...res.scored].sort((a, b) => b.composite - a.composite);
    out.push(
      table(
        ["flight", "destination", "price", "vs median", "baseline", "composite", "gates", "flags"],
        ranked.map((s) => {
          const flags: string[] = [];
          if (s.baselineDeal) flags.push("baseline deal");
          if (s.opportunity) flags.push("opportunity");
          if (s.annotation.distortion) flags.push("distorted");
          return [
            s.flight.id,
            s.flight.destinationName,
            eur(s.flight.priceEur),
            s.baseline.thin ? "thin" : pct(s.priceVsMedianPct),
            `n=${s.baseline.count}${s.baseline.median !== null ? ` med ${eur(s.baseline.median)}` : ""}`,
            score(s.composite),
            s.gates.passed ? "pass" : "fail",
            flags.join(", ")
          ];
        })
      )
    );
    const notes = ranked.filter((s) => s.gates.failures.length || s.gates.warnings.length || s.opportunityReason);
    if (notes.length) {
      out.push("");
      out.push("Notes");
      for (const s of notes) {
        for (const f of s.gates.failures) out.push(`  ${s.flight.id}: gate failed, ${f}`);
        for (const w of s.gates.warnings) out.push(`  ${s.flight.id}: warning, ${w}`);
        if (s.opportunityReason) out.push(`  ${s.flight.id}: ${s.opportunityReason}`);
      }
    }
  }
  out.push("");
  out.push(`Selection: top ${res.selection.top ?? "none"}, alternative ${res.selection.alternative ?? "none"}`);
  out.push("");
  out.push(`Watch hits (${res.watchHits.length})`);
  for (const h of res.watchHits) {
    out.push(`  ${h.name} (${h.flightId}) ${eur(h.priceEur)}: ${h.reason}${h.chatId ? ` [chat ${h.chatId}]` : ""}`);
  }
  if (res.watchHits.length === 0) out.push("  none");
  out.push("");
  out.push(`Rejected (${res.rejected.length})`);
  for (const r of res.rejected) out.push(`  ${r.flight.id} ${eur(r.flight.priceEur)}: ${r.reasons.join("; ")}`);
  if (res.rejected.length === 0) out.push("  none");
  return out.join("\n");
}

export function renderDiscovery(res: DiscoveryResponse): string {
  const out: string[] = [];
  const passed = res.scored.filter((c) => c.passed).length;
  out.push(`Discovery run ${res.runId}: ${res.scored.length} scored, ${passed} passed`);
  if (res.scored.length) {
    out.push("");
    const ranked = [...res.scored].sort((a, b) => b.composite - a.composite);
    out.push(
      table(
        ["place", "iata", "composite", "passed", "comfort now", "price signal", "flags"],
        ranked.map((c) => {
          const flags: string[] = [];
          if (c.repeatPenalty) flags.push("repeat penalty");
          if (c.thinPriceSignal) flags.push("thin price signal");
          return [
            c.name,
            c.iata ?? "",
            score(c.composite),
            c.passed ? "yes" : "no",
            c.comfortNow === null ? "n/a" : score(c.comfortNow),
            eur(c.priceSignalEur),
            flags.join(", ")
          ];
        })
      )
    );
  }
  for (const u of res.unresolved) {
    const p = u.place;
    out.push(`Not resolved: ${"cityId" in p ? p.cityId : "iata" in p ? p.iata : p.query} (${u.reason})`);
  }
  return out.join("\n");
}

export function renderTrip(res: TripResponse): string {
  return `Trip saved: ${res.trip.name || res.trip.id}\nLink: ${res.url}`;
}

export function renderNotify(res: NotifyResponse): string {
  const out = [res.deduped ? "Notice already raised (deduplicated)." : "Notice raised."];
  for (const d of res.deliveries) out.push(`  ${d.channel}: ${d.ok ? "ok" : `failed${d.error ? `, ${d.error}` : ""}`}`);
  if (res.deliveries.length === 0) out.push("  no channels configured");
  return out.join("\n");
}

export function renderRuns(res: RunsResponse): string {
  return res.runs.length ? res.runs.map(renderRunLine).join("\n") : "No runs yet.";
}

export function renderFares(res: FaresResponse): string {
  const out = [`Route ${res.route}`, `Baseline: ${JSON.stringify(res.baseline)}`];
  if (res.fares.length) {
    out.push("");
    out.push(
      table(
        ["price", "depart", "snapshot", "source"],
        res.fares.map((f) => [eur(f.priceEur), f.departDate, f.snapshotDate, f.source])
      )
    );
  } else {
    out.push("No fares stored.");
  }
  return out.join("\n");
}

export function renderImport(res: ImportResponse): string {
  return [
    `Config imported: ${res.config ? "yes" : "no"}`,
    `Wishlist: ${res.wishlist.added} added, ${res.wishlist.unresolved} unresolved`,
    `Fares: ${res.fares.added} added, ${res.fares.skipped} skipped`
  ].join("\n");
}

export function renderWishlistPatch(p: AtlasPlace): string {
  return `Updated ${p.name}:\n${renderWishlist([p])}`;
}

export function renderIdeas(ctx: Pick<ContextResponse, "ideas" | "windows" | "origin">): string {
  if (ctx.ideas.length === 0) return "No trip ideas. The wishlist is empty or every place is avoided in both windows.";
  const out: string[] = [`From ${ctx.origin.name}`];
  for (const w of ["a", "b"] as const) {
    const items = ctx.ideas.filter((i) => i.window === w);
    out.push("");
    out.push(`Window ${w.toUpperCase()}: ${ctx.windows[w].from} to ${ctx.windows[w].to}`);
    if (items.length === 0) out.push("  none");
    items.forEach((i, n) => {
      out.push(`  ${n + 1}. ${i.name}, ${i.country}${i.iata ? ` [${i.iata}]` : ""}  score ${score(i.score)}`);
      out.push(`     ${i.reasons.length ? i.reasons.join("; ") : "no figures yet"}`);
    });
  }
  return out.join("\n");
}

export function renderResearch(items: ContextResponse["researchNeeded"]): string {
  if (items.length === 0) return "No research needed. Every window month has fresh signals.";
  return table(
    ["cityId", "place", "priority", "months"],
    items.map((r) => [r.cityId, r.name, String(r.priority), monthList(r.months)])
  );
}

export function renderSignals(signals: AtlasSignal[]): string {
  if (signals.length === 0) return "No season research stored.";
  const rank = (n: number | undefined) => (n === undefined ? "n/a" : `${n}/5`);
  return table(
    ["cityId", "month", "quiet", "conditions", "events", "researched"],
    [...signals]
      .sort((a, b) => a.cityId.localeCompare(b.cityId) || a.month - b.month)
      .map((x) => [x.cityId, monthName(x.month), rank(x.quiet), rank(x.conditions), x.events.map((e) => e.title).join("; "), x.researchedAt.slice(0, 10)])
  );
}

export function renderSignalsAdd(res: SignalsAddResponse): string {
  const out = [`Stored ${res.stored} signal${res.stored === 1 ? "" : "s"}.`];
  for (const u of res.unresolved) {
    const p = u.place;
    out.push(`Not resolved: ${"cityId" in p ? p.cityId : "iata" in p ? p.iata : p.query} (${u.reason})`);
  }
  return out.join("\n");
}

export function renderFire(run: RunSummary): string {
  if (run.status === "failed") return `Run ${run.id} (${run.mode}) was recorded as failed.`;
  return `Run ${run.id} (${run.mode}) started. The routine will report through Alerts.`;
}
