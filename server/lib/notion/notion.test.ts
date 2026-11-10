import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities } from "../cities";
import { blocksToMarkdown, createNotionClient, normaliseNotionId, pageToRow, NotionError } from "./client";
import { classifyKind, dateRange, monthsOf, parseCsv, parseMonthlyBudget, parseResearchMarkdown, parseStay, researchFromRows, seasonRows } from "./read";
import { matchPlace } from "./match";
import { buildPlan } from "./plan";
import { DEFAULT_RESEARCH_MAPPING, DEFAULT_SEASONS_MAPPING, type NotionRow } from "./types";
import { applyImport, candidatePool, getStatus, previewImport, resolveReviewItem, runNotionDaily, saveConfig, writeBackRotation, PlanChangedError, NotionSetupError } from "./service";
import { putStay, readRotation } from "../rotation";

// Invented fixtures shaped like the real schema (names of places are public; the notes are made up).
const SEASONS_CSV = `Window,Location,Season,Start,End,Notes,Region
Lisbon — Dry,Lisbon,Peak — Dry,"May 1, 2026","Sep 30, 2026",Long light evenings,Europe
Lisbon — Rain,Lisbon,Avoid — Wet / Extreme,"Nov 15, 2026","Feb 15, 2027",Storm weeks,Europe
Island pair — Calm,Lisbon / Porto,Peak — Dry,"Jun 1, 2026","Jul 31, 2026",,Europe
Nowheresville — Calm,Nowheresville,Peak — Dry,"Jun 1, 2026","Jul 31, 2026",,Europe
Porto — Odd,Porto,Mystery,"Jun 1, 2026","Jul 31, 2026",,Europe
Porto — No dates,Porto,Shoulder,,,,Europe
`;

const RESEARCH_MD = `# Scores

| Location | Climate | Cost | Score |
| --- | --- | --- | --- |
| <b>Lisbon, Portugal</b> | 8.0 | 6.5 | <b>7.4</b> |
| <b>Porto</b> | 7.0 | 7.5 | <b>7.2</b> |

---

# Atlantic

<b>Lisbon, Portugal</b> — Hilly and bright. Invented note.

<i>€1,400–2,200/mo · Best: May–Sep · Avoid: Dec–Jan</i>

<b>Porto, Portugal</b> — Granite and rain. Invented note.

<i>$1,100/mo · Best: Jun–Sep</i>
`;

beforeAll(() => loadCities());

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-notion-"));
  process.env.DATA_DIR = TMP;
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.NOTION_TOKEN;
  delete process.env.NOTION_WRITE_BACK;
  vi.restoreAllMocks();
});

describe("parsing", () => {
  it("reads months, kinds and ranges", () => {
    expect(monthsOf("2026-11-15", "2027-02-15")).toEqual({ start: 11, end: 2 });
    expect(monthsOf("2026-01-01", "2026-12-31")).toEqual({ start: 1, end: 12 });
    expect(monthsOf("March 3, 2026", undefined)).toEqual({ start: 3, end: 3 });
    expect(monthsOf("garbage", "x")).toBeUndefined();
    expect(dateRange("March 3, 2026 → March 10, 2026")).toEqual({ start: "March 3, 2026", end: "March 10, 2026" });
    expect(classifyKind("Peak — Dry")).toBe("peak");
    expect(classifyKind("Avoid — Wet / Extreme")).toBe("avoid");
    expect(classifyKind("Shoulder")).toBe("shoulder");
    expect(classifyKind("Whatever")).toBeUndefined();
  });
  it("reads budgets and stays", () => {
    expect(parseMonthlyBudget("€800–1,500/mo · Best")).toEqual({ min: 800, max: 1500, currency: "EUR" });
    expect(parseMonthlyBudget("$1,100/mo")).toEqual({ min: 1100, currency: "USD" });
    expect(parseMonthlyBudget("€3,000+ for 2 weeks")).toBeUndefined();
    expect(parseStay("3-6 months")).toEqual({ minNights: 90, maxNights: 180 });
    expect(parseStay("2 weeks")).toEqual({ minNights: 14 });
    expect(parseStay("n/a")).toBeUndefined();
  });
  it("maps CSV rows through the property mapping", () => {
    const rows = seasonRows(parseCsv(SEASONS_CSV), DEFAULT_SEASONS_MAPPING);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ label: "Lisbon", kind: "peak", months: { start: 5, end: 9 }, reason: "Long light evenings", ref: "csv:lisbon-dry" });
    expect(rows[1].months).toEqual({ start: 11, end: 2 });
    expect(rows[4].problem).toBe("bad-kind");
    expect(rows[5].problem).toBe("bad-dates");
  });
  it("honours a custom mapping", () => {
    const rows: NotionRow[] = [{ id: "abc", cells: { Where: "Lisbon", Type: "Best", From: { start: "2026-05-01" }, To: { start: "2026-06-30" }, Why: "x", Name: "t" } }];
    const out = seasonRows(rows, { ...DEFAULT_SEASONS_MAPPING, place: "Where", kind: "Type", start: "From", end: "To", notes: "Why", title: "Name" });
    expect(out[0]).toMatchObject({ ref: "abc", label: "Lisbon", kind: "peak", months: { start: 5, end: 6 }, reason: "x" });
  });
  it("reads a research database by mapping, keeping own scores", () => {
    const rows: NotionRow[] = [
      { id: "p1", cells: { Name: "Lisbon", Type: "Base", "Min nights": 60, "Max nights": 120, "Budget min": 1400, "Budget max": 2000, Currency: "eur", Notes: "n", Score: 7, Climate: 8, Cost: 6, Flights: 99 } },
    ];
    const [e] = researchFromRows(rows, DEFAULT_RESEARCH_MAPPING);
    expect(e).toMatchObject({ ref: "p1", type: "base", stay: { minNights: 60, maxNights: 120 }, budgetMonthly: { min: 1400, max: 2000, currency: "EUR" }, overall: 7, scores: { Climate: 8, Cost: 6 } });
  });
  it("reads a research page: table scores plus a paragraph per place", () => {
    const es = parseResearchMarkdown(RESEARCH_MD, "pg");
    const lisbon = es.find((e) => e.label === "Lisbon")!;
    expect(lisbon).toMatchObject({ country: "Portugal", overall: 7.4, scores: { Climate: 8, Cost: 6.5 }, budgetMonthly: { min: 1400, max: 2200, currency: "EUR" }, ref: "pg#lisbon" });
    expect(lisbon.notes).toContain("Invented note");
    expect(es.find((e) => e.label === "Porto")!.budgetMonthly).toEqual({ min: 1100, currency: "USD" });
  });
});

describe("matching", () => {
  it("matches exact names, sends compounds and unknowns to review, honours aliases", () => {
    expect(matchPlace("Lisbon", undefined, {})).toMatchObject({ ok: true, cities: [{ name: "Lisbon" }] });
    expect(matchPlace("Medellin", undefined, {})).toMatchObject({ ok: true });
    const compound = matchPlace("Lisbon / Porto", undefined, {});
    expect(compound).toMatchObject({ ok: false, reason: "compound" });
    expect(matchPlace("Nowheresville", undefined, {})).toMatchObject({ ok: false, reason: "no-match" });
    expect(matchPlace("Lisbon / Porto", undefined, { "lisbon / porto": [] })).toMatchObject({ ok: false, ignored: true });
    const a = matchPlace("Lisbon / Porto", undefined, { "lisbon / porto": ["lisbon-portugal"] });
    expect(a).toMatchObject({ ok: true, via: "alias" });
  });
});

describe("plan", () => {
  const input = (over = {}) => ({
    seasons: seasonRows(parseCsv(SEASONS_CSV), DEFAULT_SEASONS_MAPPING),
    research: null,
    existingPlaces: [],
    existingPool: [],
    aliases: {},
    now: new Date("2026-11-10T00:00:00Z"),
    ...over,
  });
  it("adds windows for matched rows and queues the rest for review", () => {
    const plan = buildPlan(input());
    expect(plan.places.map((p) => p.name)).toEqual(["Lisbon"]);
    const lisbon = plan.places.find((p) => p.name === "Lisbon")!;
    expect(lisbon.added).toHaveLength(2);
    expect(plan.review.map((r) => [r.label, r.reason]).sort()).toEqual([
      ["Lisbon / Porto", "compound"],
      ["Nowheresville", "no-match"],
      ["Porto", "bad-dates"],
      ["Porto", "bad-kind"],
    ]);
    expect(plan.covers).toEqual({ seasons: true, research: false });
    expect(plan.pool).toBeNull();
  });
  it("detects updates and removals against what is stored", () => {
    const first = buildPlan(input());
    const lisbon = first.places.find((p) => p.name === "Lisbon")!;
    const stored = [
      {
        cityId: lisbon.cityId,
        name: "Lisbon",
        windows: [
          { id: "n1", kind: "peak" as const, months: { start: 4, end: 9 }, reason: "Long light evenings", source: { kind: "notion" as const, ref: "csv:lisbon-dry" } },
          { id: "n2", kind: "avoid" as const, months: { start: 1, end: 1 }, source: { kind: "notion" as const, ref: "csv:gone" } },
          { id: "h1", kind: "shoulder" as const, months: { start: 3, end: 3 }, source: { kind: "manual" as const } },
        ],
      },
    ];
    const plan = buildPlan(input({ existingPlaces: stored }));
    const l = plan.places.find((p) => p.cityId === lisbon.cityId)!;
    expect(l.updated).toHaveLength(1);
    expect(l.updated[0].before.months).toEqual({ start: 4, end: 9 });
    expect(l.added.map((w) => w.ref)).toEqual(["csv:lisbon-rain"]);
    expect(l.removed.map((w) => w.ref)).toEqual(["csv:gone"]);
  });
  it("is stable: identical input gives an identical digest", () => {
    expect(buildPlan(input()).digest).toBe(buildPlan(input()).digest);
  });
});

describe("service", () => {
  const upload = { kind: "upload" as const, seasonsCsv: SEASONS_CSV, researchMarkdown: RESEARCH_MD };

  it("applies an upload idempotently and keeps hand-written windows", async () => {
    const preview = await previewImport(upload);
    expect(preview.summary.windowsAdded).toBeGreaterThan(0);
    expect(preview.pool?.added.length).toBe(2);

    // The owner already has a hand-written window for Lisbon.
    const lisbonId = preview.places.find((p) => p.name === "Lisbon")!.cityId;
    await applyImport({ kind: "upload", seasonsCsv: SEASONS_CSV }, { expectDigest: (await previewImport({ kind: "upload", seasonsCsv: SEASONS_CSV })).digest });
    const rot1 = await readRotation();
    const profile = rot1.places.find((p) => p.cityId === lisbonId)!;
    expect(profile.windows.map((w) => w.source?.kind)).toEqual(["notion", "notion"]);

    const again = await previewImport({ kind: "upload", seasonsCsv: SEASONS_CSV });
    expect(again.summary).toMatchObject({ windowsAdded: 0, windowsUpdated: 0, windowsRemoved: 0 });
    expect(again.places).toEqual([]);

    // Changing a row in Notion updates the window rather than duplicating it.
    const changed = SEASONS_CSV.replace('"Sep 30, 2026"', '"Oct 31, 2026"');
    const r = await applyImport({ kind: "upload", seasonsCsv: changed });
    expect(r.summary.windowsUpdated).toBe(1);
    const after = (await readRotation()).places.find((p) => p.cityId === lisbonId)!;
    expect(after.windows).toHaveLength(2);
    expect(after.windows.find((w) => w.kind === "peak")!.months).toEqual({ start: 5, end: 10 });
  });

  it("refuses to apply when the data changed after the preview", async () => {
    const p = await previewImport({ kind: "upload", seasonsCsv: SEASONS_CSV });
    await expect(applyImport({ kind: "upload", seasonsCsv: SEASONS_CSV + 'Lisbon — Extra,Lisbon,Shoulder,"Mar 1, 2026","Mar 31, 2026",,x\n' }, { expectDigest: p.digest })).rejects.toBeInstanceOf(PlanChangedError);
  });

  it("stores the pool and resolves review items into aliases", async () => {
    await applyImport(upload);
    const pool = await candidatePool();
    expect(pool.map((p) => p.cityName).sort()).toEqual(["Lisbon", "Porto"]);
    expect(pool.find((p) => p.cityName === "Lisbon")!.scores).toEqual({ Climate: 8, Cost: 6.5 });
    const status = await getStatus();
    const item = status.review.find((r) => r.label === "Lisbon / Porto")!;
    expect(item).toBeTruthy();
    await resolveReviewItem(item.key, ["lisbon-portugal"]);
    const next = await previewImport({ kind: "upload", seasonsCsv: SEASONS_CSV });
    expect(next.review.find((r) => r.label === "Lisbon / Porto")).toBeUndefined();
    expect(next.places.find((p) => p.cityId === "lisbon-portugal")!.added.map((w) => w.ref)).toContain("csv:island-pair-calm");
    await expect(resolveReviewItem("x", ["no-such-city"])).rejects.toBeInstanceOf(NotionSetupError);
  });

  it("without a token or an upload says what to set", async () => {
    await expect(previewImport({ kind: "api" })).rejects.toThrow(/NOTION_SEASONS_DB/);
    await saveConfig({ seasonsDb: "https://www.notion.so/ws/Seasons-0123456789abcdef0123456789abcdef?v=1" });
    await expect(previewImport({ kind: "api" })).rejects.toThrow(/NOTION_TOKEN/);
    expect((await getStatus()).config.seasonsDb).toBe("0123456789abcdef0123456789abcdef");
  });

  it("reads through the API client", async () => {
    const client = {
      queryDatabase: vi.fn(async (id: string) =>
        id === "a".repeat(32) ? parseCsv(SEASONS_CSV) : [],
      ),
      pageMarkdown: vi.fn(async () => RESEARCH_MD),
      createPage: vi.fn(),
      updatePage: vi.fn(),
    };
    await saveConfig({ seasonsDb: "a".repeat(32), researchPage: "b".repeat(32) });
    const plan = await previewImport({ kind: "api" }, { client });
    expect(plan.covers).toEqual({ seasons: true, research: true });
    expect(client.pageMarkdown).toHaveBeenCalledWith("b".repeat(32));
    expect(plan.pool?.added[0].ref.startsWith("b".repeat(32))).toBe(true);
  });

  it("runs on the daily job only when switched on, and never throws", async () => {
    expect(await runNotionDaily()).toEqual({ skipped: "no NOTION_TOKEN" });
    process.env.NOTION_TOKEN = "t";
    expect(await runNotionDaily()).toEqual({ skipped: "daily sync is off" });
    await saveConfig({ daily: true, seasonsDb: "a".repeat(32) });
    const client = { queryDatabase: async () => parseCsv(SEASONS_CSV), pageMarkdown: async () => "", createPage: vi.fn(), updatePage: vi.fn() };
    const out = await runNotionDaily({ client });
    expect(out.import).toMatchObject({ windowsAdded: 2 });
    const failing = await runNotionDaily({ client: { ...client, queryDatabase: async () => { throw new Error("boom"); } } });
    expect(failing.importError).toBe("boom");
  });
});

describe("write-back", () => {
  const stay = (id: string, over = {}) => ({
    place: { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", lat: 38.7, lng: -9.1 },
    kind: "base",
    status: "planned",
    start: "2027-01-10",
    end: "2027-02-10",
    ...over,
  });
  it("is off until both switches are on", async () => {
    await expect(writeBackRotation({ client: { queryDatabase: vi.fn(), pageMarkdown: vi.fn(), createPage: vi.fn(), updatePage: vi.fn() } })).rejects.toBeInstanceOf(NotionSetupError);
  });
  it("creates one page per stay, updates on change, skips unchanged", async () => {
    process.env.NOTION_WRITE_BACK = "1";
    process.env.NOTION_TOKEN = "t";
    await saveConfig({ writeBack: { enabled: true, database: "c".repeat(32) } });
    await putStay("s1", stay("s1") as never, undefined, new Date("2026-11-01T00:00:00Z"));
    await putStay("s2", stay("s2", { status: "idea" }) as never, undefined);
    const client = { queryDatabase: vi.fn(), pageMarkdown: vi.fn(), createPage: vi.fn(async (_b: unknown) => ({ id: "page-1" })), updatePage: vi.fn(async () => {}) };
    expect(await writeBackRotation({ client })).toEqual({ created: 1, updated: 0, skipped: 0 });
    expect(client.createPage.mock.calls[0][0]).toMatchObject({ parent: { database_id: "c".repeat(32) }, properties: { Dates: { date: { start: "2027-01-10", end: "2027-02-10" } }, Status: { select: { name: "planned" } } } });
    expect(await writeBackRotation({ client })).toEqual({ created: 0, updated: 0, skipped: 1 });
    const cur = (await readRotation()).stays.find((s) => s.id === "s1")!;
    await putStay("s1", { ...stay("s1"), end: "2027-02-20" } as never, cur.updatedAt, new Date("2026-11-02T00:00:00Z"));
    expect(await writeBackRotation({ client })).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(client.updatePage).toHaveBeenCalledWith("page-1", expect.anything());
  });
});

describe("REST client", () => {
  const res = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  it("normalises ids", () => {
    expect(normaliseNotionId("https://www.notion.so/My-DB-0123456789abcdef0123456789abcdef?v=abc")).toBe("0123456789abcdef0123456789abcdef");
    expect(normaliseNotionId("01234567-89ab-cdef-0123-456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(normaliseNotionId("nope")).toBeUndefined();
  });
  it("paginates, sends the token and version, skips archived pages, flattens properties", async () => {
    const page = (id: string, extra = {}) => ({
      id: `${id}-0000-0000-0000-000000000000`,
      archived: false,
      properties: {
        Window: { type: "title", title: [{ plain_text: "T" }] },
        Season: { type: "select", select: { name: "Shoulder" } },
        Start: { type: "date", date: { start: "2026-03-01", end: null } },
        Score: { type: "number", number: 7 },
        Tags: { type: "multi_select", multi_select: [{ name: "a" }] },
        Link: { type: "relation", relation: [] },
      },
      ...extra,
    });
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? res({ results: [page("1"), page("2", { archived: true })], has_more: true, next_cursor: "c2" }) : res({ results: [page("3")], has_more: false });
    });
    const rows = await createNotionClient("secret", fetchMock).queryDatabase("d".repeat(32));
    expect(rows.map((r) => r.id.slice(0, 1))).toEqual(["1", "3"]);
    expect(rows[0].cells).toMatchObject({ Window: "T", Season: "Shoulder", Start: { start: "2026-03-01", end: null }, Score: 7, Tags: ["a"], Link: null });
    expect(calls[0].url).toBe(`https://api.notion.com/v1/databases/${"d".repeat(32)}/query`);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(calls[1].init!.body as string).start_cursor).toBe("c2");
  });
  it("backs off on 429 and keeps page content out of errors", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? res({}, 429, { "retry-after": "2" }) : res({ results: [], has_more: false })));
    await createNotionClient("t", f, async (ms) => void sleeps.push(ms)).queryDatabase("e".repeat(32));
    expect(sleeps).toEqual([2000]);
    const bad = createNotionClient("t", async () => res({ code: "object_not_found", message: "Could not find page titled Secret Plans" }, 404));
    const err = await bad.queryDatabase("e".repeat(32)).catch((e) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect(err.message).toBe("Notion answered 404 (object_not_found)");
  });
  it("turns blocks into the Markdown the page parser reads", async () => {
    const rt = (t: string, a = {}) => [{ plain_text: t, annotations: a }];
    const md = blocksToMarkdown([
      { id: "1", type: "heading_1", heading_1: { rich_text: rt("Scores") } },
      { id: "2", type: "table", has_children: true, table: {}, children: [
        { id: "r1", type: "table_row", table_row: { cells: [rt("Location"), rt("Climate"), rt("Score")] } },
        { id: "r2", type: "table_row", table_row: { cells: [rt("Lisbon, Portugal", { bold: true }), rt("8.0"), rt("7.4")] } },
      ] },
      { id: "3", type: "paragraph", paragraph: { rich_text: [...rt("Lisbon, Portugal", { bold: true }), ...rt(" — Bright.")] } },
      { id: "4", type: "paragraph", paragraph: { rich_text: rt("€1,400–2,200/mo · Best: May–Sep", { italic: true }) } },
    ] as never);
    const [e] = parseResearchMarkdown(md);
    expect(e).toMatchObject({ label: "Lisbon", country: "Portugal", overall: 7.4, budgetMonthly: { min: 1400, max: 2200, currency: "EUR" } });
    expect(pageToRow({ id: "a-b", properties: {} }).id).toBe("ab");
  });
});
