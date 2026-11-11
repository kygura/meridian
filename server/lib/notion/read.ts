// Reads Notion data into the importer's shapes: CSV exports of a database, the Markdown of a
// page (from an export or from the API's blocks), and rows by property mapping.
// Pure functions; no I/O.

import { parse } from "csv-parse/sync";
import type { Cell, NotionRow, ResearchEntry, ResearchMapping, SeasonsMapping } from "./types.js";

export const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const slug = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// ── Cell accessors (REST values are typed, CSV values are all strings) ──

export function text(c: Cell | undefined): string {
  if (c == null) return "";
  if (typeof c === "string") return c.trim();
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.join(", ");
  return c.start;
}

export function numeric(c: Cell | undefined): number | undefined {
  if (typeof c === "number") return Number.isFinite(c) ? c : undefined;
  if (typeof c !== "string") return undefined;
  const n = Number(c.replace(/[,\s]/g, ""));
  return c.trim() && Number.isFinite(n) ? n : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A day (YYYY-MM-DD) out of an ISO string or a Notion export string such as "March 3, 2026". */
export function dayOf(s: string): { y: number; m: number; d: number } | undefined {
  const t = s.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const named = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const m = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
    if (m > 0) return { y: +named[3], m, d: +named[2] };
  }
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { y: +us[3], m: +us[1], d: +us[2] };
  return undefined;
}

/** Start and end of a date cell: a REST range, or a CSV "A → B" string. */
export function dateRange(c: Cell | undefined): { start?: string; end?: string } {
  if (c == null) return {};
  if (typeof c === "object" && !Array.isArray(c)) return { start: c.start, end: c.end ?? undefined };
  if (typeof c !== "string" || !c.trim()) return {};
  const [a, b] = c.split(/\s*(?:→|->|\bto\b)\s*/);
  return { start: a, end: b };
}

// ── CSV ──────────────────────────────────────────────────────────────

/** A Notion CSV export: first row is the property names. Rows get a placeholder id; mappings fill in a stable one. */
export function parseCsv(csv: string): NotionRow[] {
  const records = parse(csv, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Record<string, string>[];
  return records.map((r, i) => ({ id: `csv-row-${i}`, cells: r }));
}

// ── Travel Seasons rows ──────────────────────────────────────────────

export interface SeasonRow {
  ref: string;
  label: string;
  country?: string;
  kind?: "peak" | "shoulder" | "avoid";
  months?: { start: number; end: number };
  reason?: string;
  problem?: "bad-dates" | "bad-kind";
  lastEdited?: string;
}

export function classifyKind(label: string): "peak" | "shoulder" | "avoid" | undefined {
  const l = fold(label);
  if (/\bavoid\b|\bwet\b|extreme|\boff.?season\b/.test(l)) return "avoid";
  if (/\bpeak\b|\bbest\b|\bdry\b/.test(l)) return "peak";
  if (/shoulder/.test(l)) return "shoulder";
  return undefined;
}

/** Month span of a start/end pair. Year does not matter; a range of nearly a year or more is the whole year. */
export function monthsOf(start: string | undefined, end: string | undefined): { start: number; end: number } | undefined {
  const a = start ? dayOf(start) : undefined;
  const b = end ? dayOf(end) : a;
  if (!a || !b) return undefined;
  const days = (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000;
  if (days >= 335) return { start: 1, end: 12 };
  if (days < 0) return undefined;
  return { start: a.m, end: b.m };
}

export function seasonRows(rows: NotionRow[], m: SeasonsMapping): SeasonRow[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const title = text(r.cells[m.title]);
    const label = text(r.cells[m.place]) || title.split(/\s[—–-]\s/)[0].trim();
    const base = r.id.startsWith("csv-row-") ? `csv:${slug(title || label)}` : r.id;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const ref = n ? `${base}~${n}` : base;
    const s = dateRange(r.cells[m.start]);
    const e = dateRange(r.cells[m.end]);
    const months = monthsOf(s.start, e.end ?? e.start ?? s.end);
    const kind = classifyKind(text(r.cells[m.kind]));
    const reason = (text(r.cells[m.notes]) || title).slice(0, 300) || undefined;
    const country = text(r.cells[m.country]) || undefined;
    const out: SeasonRow = { ref, label, country, kind, months, reason, lastEdited: r.lastEdited };
    if (!kind) out.problem = "bad-kind";
    else if (!months) out.problem = "bad-dates";
    return out;
  });
}

// ── Location Research ────────────────────────────────────────────────

const CURRENCY: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP" };

/** "€800–1,500/mo", "$1,200/mo", "EUR 900-1300 / month". */
export function parseMonthlyBudget(s: string): { min: number; max?: number; currency: string } | undefined {
  const m = s.match(/(€|\$|£|\b[A-Z]{3}\b)\s?([\d][\d,.]*)\s*(?:[–—-]\s*(?:(?:€|\$|£)\s?)?([\d][\d,.]*))?\s*\+?\s*\/\s*(?:mo|month)/i);
  if (!m) return undefined;
  const n = (x: string) => Number(x.replace(/,/g, ""));
  const min = n(m[2]);
  const max = m[3] ? n(m[3]) : undefined;
  if (!Number.isFinite(min) || (max !== undefined && !Number.isFinite(max))) return undefined;
  return { min, ...(max !== undefined && max >= min ? { max } : {}), currency: CURRENCY[m[1]] ?? m[1].toUpperCase() };
}

/** "3-6 months", "30 to 90 nights", "2 weeks", "6 months". */
export function parseStay(s: string): { minNights?: number; maxNights?: number } | undefined {
  const m = s.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:[–—-]|to)?\s*(\d+(?:\.\d+)?)?\s*(night|day|week|month)/);
  if (!m) return undefined;
  const unit = { night: 1, day: 1, week: 7, month: 30 }[m[3] as "night"];
  const lo = Math.round(+m[1] * unit);
  const hi = m[2] ? Math.round(+m[2] * unit) : undefined;
  return { minNights: lo, ...(hi && hi >= lo ? { maxNights: hi } : {}) };
}

function typeOf(s: string): "base" | "pass-through" | undefined {
  const l = fold(s);
  if (/pass|hub|transit/.test(l)) return "pass-through";
  if (/base/.test(l)) return "base";
  return undefined;
}

export function researchFromRows(rows: NotionRow[], m: ResearchMapping): ResearchEntry[] {
  const named = new Set([m.name, m.country, m.type, m.stay, m.stayMin, m.stayMax, m.budget, m.budgetMin, m.budgetMax, m.currency, m.notes, m.overall]);
  const seen = new Map<string, number>();
  const out: ResearchEntry[] = [];
  for (const r of rows) {
    const label = text(r.cells[m.name]);
    if (!label) continue;
    const base = r.id.startsWith("csv-row-") ? `csv:${slug(label)}` : r.id;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.cells)) {
      const x = numeric(v);
      if (!named.has(k) && x !== undefined && x >= 0 && x <= 10) scores[k] = x;
    }
    const stayMin = numeric(r.cells[m.stayMin]);
    const stayMax = numeric(r.cells[m.stayMax]);
    const stay = stayMin || stayMax ? { minNights: stayMin, maxNights: stayMax } : parseStay(text(r.cells[m.stay]));
    const bMin = numeric(r.cells[m.budgetMin]);
    const bMax = numeric(r.cells[m.budgetMax]);
    const budgetMonthly =
      bMin !== undefined
        ? { min: bMin, ...(bMax !== undefined && bMax >= bMin ? { max: bMax } : {}), currency: text(r.cells[m.currency]).toUpperCase() || "EUR" }
        : parseMonthlyBudget(text(r.cells[m.budget]));
    out.push({
      ref: n ? `${base}~${n}` : base,
      label,
      country: text(r.cells[m.country]) || undefined,
      type: typeOf(text(r.cells[m.type])),
      stay: stay && (stay.minNights || stay.maxNights) ? stay : undefined,
      budgetMonthly,
      notes: text(r.cells[m.notes]).slice(0, 4000) || undefined,
      scores,
      overall: numeric(r.cells[m.overall]),
      sourceUpdated: r.lastEdited,
    });
  }
  return out;
}

// ── Location Research as a page (score table + a paragraph per place) ─

const unHtml = (s: string) => s.replace(/<\/?b>/g, "**").replace(/<\/?i>/g, "*").replace(/\\([~$&*_])/g, "$1");

function splitLabel(raw: string): { label: string; country?: string } {
  const t = raw.replace(/\*+/g, "").trim();
  const i = t.lastIndexOf(",");
  if (i > 0) {
    const country = t.slice(i + 1).trim();
    if (country && !/[/()—–]/.test(country)) return { label: t.slice(0, i).trim(), country };
  }
  return { label: t };
}

/**
 * `pageId` namespaces the refs so that re-importing the same page updates entries by label.
 * Table rows give the owner's scores; each bold "Place - text" paragraph followed by an italic
 * line gives notes and, when the line has one, a monthly budget in a stated currency.
 */
export function parseResearchMarkdown(markdown: string, pageId = "page"): ResearchEntry[] {
  const lines = unHtml(markdown).split(/\r?\n/);
  const byKey = new Map<string, ResearchEntry>();
  const add = (raw: string, patch: Partial<ResearchEntry>) => {
    const { label, country } = splitLabel(raw);
    if (!label) return;
    const key = fold(label);
    const cur = byKey.get(key) ?? { ref: `${pageId}#${slug(label)}`, label, country, scores: {} };
    byKey.set(key, { ...cur, ...patch, scores: { ...cur.scores, ...(patch.scores ?? {}) }, country: cur.country ?? country });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("|") && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/\*+/g, "").trim());
      const head = cells(line);
      i += 2;
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        const row = cells(lines[i]);
        const scores: Record<string, number> = {};
        let overall: number | undefined;
        head.forEach((h, c) => {
          const v = c === 0 ? undefined : numeric(row[c]);
          if (v === undefined) return;
          if (/^score$/i.test(h)) overall = v;
          else scores[h] = v;
        });
        add(row[0], { scores, ...(overall !== undefined ? { overall } : {}) });
      }
      i--;
      continue;
    }
    const m = line.match(/^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const it = lines[j]?.trim().match(/^\*(?!\*)(.+?)\*$/);
    const facts = it?.[1];
    const notes = [m[2], facts].filter(Boolean).join("\n").replace(/\\/g, "").slice(0, 4000);
    add(m[1], { notes, budgetMonthly: facts ? parseMonthlyBudget(facts) : undefined });
  }
  return [...byKey.values()];
}
