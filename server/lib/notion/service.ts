// The Notion bridge (ADR 0017): preview and apply an import from the Notion API or from an
// uploaded export, settings, the review list, optional write-back and the daily job.
// The token is read from NOTION_TOKEN only; it is never stored or returned.

import { mergeImportedWindows, type PersonalWindow, type PlaceProfile } from "../../../src/lib/rotation.js";
import { getCityById } from "../cities.js";
import { createJsonStore } from "../jsonStore.js";
import { putPlace, readRotation } from "../rotation.js";
import { NotionError, createNotionClient, normaliseNotionId, notionToken, type FetchLike, type NotionClient } from "./client.js";
import { buildPlan, type Plan } from "./plan.js";
import { fold, parseCsv, parseResearchMarkdown, researchFromRows, seasonRows, type SeasonRow } from "./read.js";
import { DEFAULT_CONFIG, type NotionConfig, type PoolEntry, type ResearchEntry, type ReviewItem } from "./types.js";

interface LastRun {
  at: string;
  source: "api" | "upload";
  trigger: "manual" | "daily";
  summary: Plan["summary"];
}

interface NotionFile {
  version: 1;
  config: NotionConfig;
  pool: PoolEntry[];
  review: ReviewItem[];
  lastRun?: LastRun;
  /** Write-back bookkeeping: rotation stay id to the Notion page made for it, and the stay's updatedAt last written. */
  written: Record<string, { page: string; stamp: string }>;
}

const store = createJsonStore<NotionFile>("notion.json", () => ({ version: 1, config: structuredClone(DEFAULT_CONFIG), pool: [], review: [], written: {} }));

export class NotionSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionSetupError";
  }
}
export class PlanChangedError extends Error {
  constructor() {
    super("Notion changed after the preview. Preview again before applying.");
    this.name = "PlanChangedError";
  }
}

export interface Deps {
  client?: NotionClient;
  fetch?: FetchLike;
  now?: () => Date;
}

export type UploadSource = { kind: "upload"; seasonsCsv?: string; researchCsv?: string; researchMarkdown?: string };
export type Source = { kind: "api" } | UploadSource;

// ── Config ───────────────────────────────────────────────────────────

async function readFile(): Promise<NotionFile> {
  const f = await store.read();
  return { ...f, config: { ...DEFAULT_CONFIG, ...f.config, seasons: { ...DEFAULT_CONFIG.seasons, ...f.config?.seasons }, research: { ...DEFAULT_CONFIG.research, ...f.config?.research }, writeBack: { ...DEFAULT_CONFIG.writeBack, ...f.config?.writeBack } } };
}

/** Env ids fill in what Settings has not set. */
function resolved(cfg: NotionConfig) {
  return {
    seasonsDb: normaliseNotionId(cfg.seasonsDb) ?? normaliseNotionId(process.env.NOTION_SEASONS_DB),
    researchDb: normaliseNotionId(cfg.researchDb) ?? normaliseNotionId(process.env.NOTION_RESEARCH_DB),
    researchPage: normaliseNotionId(cfg.researchPage) ?? normaliseNotionId(process.env.NOTION_RESEARCH_PAGE),
    writeBackDb: normaliseNotionId(cfg.writeBack.database) ?? normaliseNotionId(process.env.NOTION_WRITE_BACK_DB),
  };
}

const writeBackAllowed = () => process.env.NOTION_WRITE_BACK === "1";

export async function getStatus() {
  const f = await readFile();
  const ids = resolved(f.config);
  return {
    tokenSet: !!notionToken(),
    config: f.config,
    resolved: { seasonsDb: !!ids.seasonsDb, researchDb: !!ids.researchDb, researchPage: !!ids.researchPage, writeBackDb: !!ids.writeBackDb },
    writeBackAllowed: writeBackAllowed(),
    pool: f.pool.length,
    review: f.review,
    lastRun: f.lastRun ?? null,
  };
}

export type ConfigPatch = Partial<Pick<NotionConfig, "seasonsDb" | "researchDb" | "researchPage" | "daily">> & {
  seasons?: Partial<NotionConfig["seasons"]>;
  research?: Partial<NotionConfig["research"]>;
  writeBack?: Partial<NotionConfig["writeBack"]>;
};

/** An empty string clears an id. Ids are normalised so a pasted URL works. */
export async function saveConfig(patch: ConfigPatch): Promise<NotionConfig> {
  return store.update((f) => {
    const c = (f.config = { ...DEFAULT_CONFIG, ...f.config });
    const id = (v: string | undefined, cur: string | undefined) => (v === undefined ? cur : v === "" ? undefined : normaliseNotionId(v) ?? cur);
    c.seasonsDb = id(patch.seasonsDb, c.seasonsDb);
    c.researchDb = id(patch.researchDb, c.researchDb);
    c.researchPage = id(patch.researchPage, c.researchPage);
    if (patch.daily !== undefined) c.daily = patch.daily;
    c.seasons = { ...DEFAULT_CONFIG.seasons, ...c.seasons, ...patch.seasons };
    c.research = { ...DEFAULT_CONFIG.research, ...c.research, ...patch.research };
    c.writeBack = { ...DEFAULT_CONFIG.writeBack, ...c.writeBack, ...patch.writeBack, database: id(patch.writeBack?.database, c.writeBack?.database) };
    return c;
  });
}

// ── Reading a source ─────────────────────────────────────────────────

function clientFor(deps: Deps): NotionClient {
  if (deps.client) return deps.client;
  const token = notionToken();
  if (!token) throw new NotionSetupError("Set NOTION_TOKEN to an internal integration token, and share your databases with that integration. Or upload a Notion export instead.");
  return createNotionClient(token, deps.fetch);
}

async function gather(cfg: NotionConfig, source: Source, deps: Deps): Promise<{ seasons: SeasonRow[] | null; research: ResearchEntry[] | null }> {
  if (source.kind === "upload") {
    const seasons = source.seasonsCsv?.trim() ? seasonRows(parseCsv(source.seasonsCsv), cfg.seasons) : null;
    const research = source.researchMarkdown?.trim()
      ? parseResearchMarkdown(source.researchMarkdown, "upload")
      : source.researchCsv?.trim()
        ? researchFromRows(parseCsv(source.researchCsv), cfg.research)
        : null;
    if (!seasons && !research) throw new NotionSetupError("Choose a Travel Seasons CSV and/or a Location Research CSV or Markdown file.");
    return { seasons, research };
  }
  const ids = resolved(cfg);
  if (!ids.seasonsDb && !ids.researchDb && !ids.researchPage) throw new NotionSetupError("Add the Travel Seasons database id (and the Location Research database or page) in Settings, or set NOTION_SEASONS_DB and NOTION_RESEARCH_DB / NOTION_RESEARCH_PAGE.");
  const client = clientFor(deps);
  const seasons = ids.seasonsDb ? seasonRows(await client.queryDatabase(ids.seasonsDb), cfg.seasons) : null;
  let research: ResearchEntry[] | null = null;
  if (ids.researchDb) research = researchFromRows(await client.queryDatabase(ids.researchDb), cfg.research);
  else if (ids.researchPage) research = parseResearchMarkdown(await client.pageMarkdown(ids.researchPage), ids.researchPage);
  return { seasons, research };
}

// ── Preview and apply ────────────────────────────────────────────────

async function planFor(source: Source, deps: Deps) {
  const f = await readFile();
  const [{ seasons, research }, rot] = await Promise.all([gather(f.config, source, deps), readRotation()]);
  const plan = buildPlan({ seasons, research, existingPlaces: rot.places, existingPool: f.pool, aliases: f.config.aliases, now: deps.now?.() ?? new Date() });
  return { plan, file: f, rot, covered: { seasons: seasons !== null, research: research !== null } };
}

export async function previewImport(source: Source, deps: Deps = {}): Promise<Plan> {
  return (await planFor(source, deps)).plan;
}

const toWindow = (w: { ref: string; kind: PersonalWindow["kind"]; months: PersonalWindow["months"]; reason?: string }): PersonalWindow => ({
  id: `notion:${w.ref}`.slice(0, 100),
  kind: w.kind,
  months: w.months,
  ...(w.reason ? { reason: w.reason } : {}),
  source: { kind: "notion", ref: w.ref },
});

async function writePlace(cityId: string, name: string, country: string, next: Parameters<typeof toWindow>[0][]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (await readRotation()).places.find((p) => p.cityId === cityId);
    const base: PlaceProfile = existing ?? { cityId, name, country, windows: [] };
    const merged = mergeImportedWindows(base, next.map(toWindow), "notion");
    const r = await putPlace(
      cityId,
      { name: merged.name, country: merged.country, windows: merged.windows.slice(0, 48), leadTime: merged.leadTime, notes: merged.notes },
      existing?.updatedAt,
    );
    if (r.ok) return;
  }
  throw new Error(`Could not save windows for ${name}: the place changed while importing.`);
}

export async function applyImport(source: Source, opts: { expectDigest?: string; trigger?: "manual" | "daily" } = {}, deps: Deps = {}): Promise<{ summary: Plan["summary"]; review: ReviewItem[] }> {
  const { plan, covered } = await planFor(source, deps);
  if (opts.expectDigest && opts.expectDigest !== plan.digest) throw new PlanChangedError();
  for (const p of plan.places) await writePlace(p.cityId, p.name, p.country, p.next);
  const now = (deps.now?.() ?? new Date()).toISOString();
  await store.update((f) => {
    if (plan.pool) f.pool = plan.pool.next;
    // A database this import did not cover keeps its review items.
    f.review = [...f.review.filter((r) => !covered[r.db]), ...plan.review];
    f.lastRun = { at: now, source: source.kind, trigger: opts.trigger ?? "manual", summary: plan.summary };
  });
  return { summary: plan.summary, review: plan.review };
}

// ── Pool and review ──────────────────────────────────────────────────

/** The candidate place pool: the owner's Location Research entries matched to cities. */
export async function candidatePool(): Promise<PoolEntry[]> {
  return (await readFile()).pool;
}

/** The owner's answer to a review item: the cities its label stands for, or none to ignore it. Remembered for every later import. */
export async function resolveReviewItem(key: string, cityIds: string[]): Promise<boolean> {
  const bad = cityIds.filter((id) => !getCityById(id));
  if (bad.length) throw new NotionSetupError("Unknown city.");
  return store.update((f) => {
    const item = f.review.find((r) => r.key === key);
    if (!item) return false;
    f.config = { ...DEFAULT_CONFIG, ...f.config };
    f.config.aliases = { ...f.config.aliases, [fold(item.label)]: cityIds };
    f.review = f.review.filter((r) => fold(r.label) !== fold(item.label));
    return true;
  });
}

// ── Write-back (off by default) ──────────────────────────────────────

const lastDay = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

/**
 * Writes each committed stay of the rotation to a Notion database with the properties
 * Name (title), Dates (date), Status (select) and Place (text). One page per stay, made once and
 * updated when the stay changes; stays that disappear are left in Notion. Sends only the
 * owner's own plan to the owner's own workspace, and only when switched on twice (NOTION_WRITE_BACK=1 and the Settings toggle).
 */
export async function writeBackRotation(deps: Deps = {}): Promise<{ created: number; updated: number; skipped: number }> {
  const f = await readFile();
  const db = resolved(f.config).writeBackDb;
  if (!writeBackAllowed() || !f.config.writeBack.enabled) throw new NotionSetupError("Write-back is off. Set NOTION_WRITE_BACK=1 and switch it on in Settings.");
  if (!db) throw new NotionSetupError("Add the database to write to in Settings (or NOTION_WRITE_BACK_DB).");
  const client = clientFor(deps);
  const { stays } = await readRotation();
  const out = { created: 0, updated: 0, skipped: 0 };
  const written = { ...f.written };
  for (const s of stays) {
    if (s.status === "idea") continue;
    const start = s.start ?? (s.window ? `${s.window.from}-01` : undefined);
    const end = s.end ?? (s.window ? lastDay(s.window.to) : undefined);
    if (!start) {
      out.skipped++;
      continue;
    }
    const stamp = s.updatedAt ?? "";
    const prev = written[s.id];
    if (prev && prev.stamp === stamp) {
      out.skipped++;
      continue;
    }
    const properties = {
      Name: { title: [{ text: { content: s.place.name } }] },
      Dates: { date: { start, ...(end ? { end } : {}) } },
      Status: { select: { name: s.status } },
      Place: { rich_text: [{ text: { content: [s.place.name, s.place.country].filter(Boolean).join(", ") } }] },
    };
    if (prev) {
      await client.updatePage(prev.page, { properties });
      out.updated++;
      written[s.id] = { page: prev.page, stamp };
    } else {
      const page = await client.createPage({ parent: { database_id: db }, properties });
      out.created++;
      written[s.id] = { page: page.id, stamp };
    }
  }
  await store.update((x) => {
    x.written = written;
  });
  return out;
}

// ── Daily job ────────────────────────────────────────────────────────

/** For the daily-job hook: applies the import when Settings says so, and writes back when that is on. Never throws. */
export async function runNotionDaily(deps: Deps = {}): Promise<Record<string, unknown>> {
  const f = await readFile();
  const out: Record<string, unknown> = {};
  if (!notionToken()) return { skipped: "no NOTION_TOKEN" };
  if (f.config.daily) {
    try {
      out.import = (await applyImport({ kind: "api" }, { trigger: "daily" }, deps)).summary;
    } catch (err) {
      out.importError = err instanceof Error ? err.message : "failed";
    }
  }
  if (f.config.writeBack.enabled && writeBackAllowed()) {
    try {
      out.writeBack = await writeBackRotation(deps);
    } catch (err) {
      out.writeBackError = err instanceof Error ? err.message : "failed";
    }
  }
  if (!Object.keys(out).length) out.skipped = "daily sync is off";
  return out;
}

export { NotionError };
