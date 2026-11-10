import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities } from "./cities";
import { putStay, readRotation, putSettings } from "./rotation";
import { putSolverSettings, readSolverDoc } from "./solverStore";
import { decideProposal, listProposals, runReplan, type ReplanDeps } from "./replan";
import { DEFAULT_SOLVER_SETTINGS } from "../../src/lib/solver/settings";
import type { NotifyInput } from "./notifier";

beforeAll(() => loadCities());

const place = (cityId: string, name: string, country: string, lat: number, lng: number, iata: string) => ({ cityId, name, country, lat, lng, iata });
const LIS = place("lisbon-portugal", "Lisbon", "Portugal", 38.72, -9.14, "LIS");
const CNX = place("chiang-mai-thailand", "Chiang Mai", "Thailand", 18.79, 98.98, "CNX");
const TBS = place("tbilisi-georgia", "Tbilisi", "Georgia", 41.72, 44.79, "TBS");

/** Fake sources: clean air and normal weather unless told otherwise. */
function fakeDeps(over: Partial<ReplanDeps> = {}) {
  const sent: NotifyInput[] = [];
  const deps: ReplanDeps = {
    news: async () => ({ issues: [], flags: [] }),
    observedTemp: async () => ({ tempC: 20, normalTempC: 20 }),
    recentPm25: async () => 12,
    normalPm25: async () => 12,
    fare: async () => null,
    notify: async (n) => {
      sent.push(n);
    },
    ...over,
  };
  return { deps, sent };
}

describe("re-plan loop", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-replan-"));
    process.env.DATA_DIR = TMP;
    await putSettings({ name: "Mine", horizonMonths: 12 }, undefined);
    await putStay("now", { place: LIS, kind: "base", status: "booked", start: "2026-11-01", end: "2026-12-10" } as never, undefined);
    await putStay("next", { place: CNX, kind: "base", status: "planned", start: "2026-12-10", end: "2027-02-20" } as never, undefined);
    await putStay("after", { place: TBS, kind: "base", status: "planned", start: "2027-02-20", end: "2027-05-01" } as never, undefined);
    await putSolverSettings({
      ...DEFAULT_SOLVER_SETTINGS,
      months: 12,
      pool: [
        { cityId: "lisbon-portugal", kind: "base" },
        { cityId: "chiang-mai-thailand", kind: "base" },
        { cityId: "tbilisi-georgia", kind: "base" },
        { cityId: "da-nang-vietnam", kind: "base" },
        { cityId: "mexico-city-mexico", kind: "base" },
      ],
    } as never);
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("stays quiet when nothing has shifted", async () => {
    const { deps, sent } = fakeDeps();
    const r = await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    expect(r.watched).toBe(3);
    expect(r.proposals).toBe(0);
    expect(sent.filter((n) => n.kind === "replan")).toEqual([]);
  });

  it("raises one proposal with evidence and plan B on an air shift, sends it once, and does not repeat", async () => {
    const { deps, sent } = fakeDeps({ recentPm25: async (lat) => (lat > 18 && lat < 19 ? 95 : 12), normalPm25: async () => 20 });
    const r1 = await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    expect(r1.proposals).toBe(1);
    const [p] = await listProposals("2026-11-10");
    expect(p.status).toBe("open");
    expect(p.shifts[0].kind).toBe("air");
    expect(p.shifts[0].evidence[0].source).toMatch(/Open-Meteo/);
    expect(p.planB).not.toBeNull();
    // Booked Lisbon is kept; Chiang Mai is penalised, so plan B moves away from it.
    expect(p.planB!.stays.find((s) => s.id === "now")?.role).toBe("fixed");
    expect(p.diff!.stays.some((c) => c.kind !== "unchanged")).toBe(true);
    expect(sent.filter((n) => n.kind === "replan")).toHaveLength(1);

    // Same reading the next days: no new proposal, no new notice.
    for (const d of ["2026-11-11", "2026-11-12", "2026-11-13"]) {
      const r = await runReplan({ now: new Date(`${d}T06:00:00Z`), deps });
      expect(r.proposals).toBe(0);
    }
    expect(sent.filter((n) => n.kind === "replan")).toHaveLength(1);
    expect((await readSolverDoc()).proposals).toHaveLength(1);
  });

  it("does not count a source it could not reach as a clearing", async () => {
    let pm: number | null = 95;
    const { deps } = fakeDeps({ recentPm25: async (lat) => (lat > 18 && lat < 19 ? pm : 12), normalPm25: async () => 20 });
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    pm = null; // unreachable
    const r = await runReplan({ now: new Date("2026-11-11T06:00:00Z"), deps });
    expect(r.notes.join(" ")).toMatch(/Not checked: .*air quality for Chiang Mai/);
    expect((await readSolverDoc()).shifts["air:next"].active).toBe(true);
  });

  it("sends book-by reminders through the notifier, deduped by key", async () => {
    const { deps, sent } = fakeDeps();
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    const keys = sent.filter((n) => n.kind === "book-by").map((n) => n.dedupeKey);
    // Chiang Mai (from 10 Dec, ~8 weeks lead) is overdue; its key is stable across runs.
    expect(keys.some((k) => k.startsWith("book-by:next:"))).toBe(true);
    await runReplan({ now: new Date("2026-11-10T07:00:00Z"), deps });
    const again = sent.filter((n) => n.kind === "book-by").map((n) => n.dedupeKey);
    expect(new Set(again).size).toBe(new Set(keys).size);
  });

  it("changes nothing until accepted; dismiss and snooze leave the rotation alone", async () => {
    const { deps } = fakeDeps({ recentPm25: async (lat) => (lat > 18 && lat < 19 ? 95 : 12), normalPm25: async () => 20 });
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    const before = (await readRotation()).stays.map((s) => s.id).sort();
    const [p] = await listProposals("2026-11-10");
    const snoozed = await decideProposal(p.id, "snooze", { days: 3, now: new Date("2026-11-10T08:00:00Z") });
    expect("proposal" in snoozed && snoozed.proposal.status).toBe("snoozed");
    expect((await listProposals("2026-11-12"))[0].status).toBe("snoozed");
    expect((await listProposals("2026-11-13"))[0].status).toBe("open");
    expect((await readRotation()).stays.map((s) => s.id).sort()).toEqual(before);
    const acc = await decideProposal(p.id, "accept", { now: new Date("2026-11-10T09:00:00Z") });
    expect("proposal" in acc && acc.proposal.status).toBe("accepted");
    const after = (await readRotation()).stays;
    expect(after.find((s) => s.id === "now")).toBeTruthy();
    expect(after.some((s) => s.origin?.kind === "solver")).toBe(true);
    const again = await decideProposal(p.id, "dismiss");
    expect("error" in again && again.error).toBe("not_open");
  });

  it("refuses a stale plan B", async () => {
    const { deps } = fakeDeps({ recentPm25: async (lat) => (lat > 18 && lat < 19 ? 95 : 12), normalPm25: async () => 20 });
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    const [p] = await listProposals("2026-11-10");
    const cur = (await readRotation()).stays.find((s) => s.id === "now")!;
    await putStay("now", { place: LIS, kind: "base", status: "booked", start: "2026-11-01", end: "2026-11-25" } as never, cur.updatedAt);
    const r = await decideProposal(p.id, "accept");
    expect("error" in r && r.error).toBe("stale");
  });

  it("treats a fare drop as news: a notice, no re-plan, and an open proposal stays open", async () => {
    let fare = 500;
    const { deps, sent } = fakeDeps({
      recentPm25: async (lat) => (lat > 18 && lat < 19 ? 95 : 12),
      normalPm25: async () => 20,
      fare: async () => ({ price: fare, currency: "EUR", source: "Duffel" }),
    });
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    const [open] = await listProposals("2026-11-10");
    expect(open.status).toBe("open");
    fare = 300; // down 40%
    const r = await runReplan({ now: new Date("2026-11-11T06:00:00Z"), deps });
    expect(r.fired).toBe(1);
    expect(r.proposals).toBe(0);
    const all = await listProposals("2026-11-11");
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("open");
    expect(sent.filter((n) => n.kind === "replan")).toHaveLength(1);
    const drop = sent.filter((n) => n.kind === "fare-drop");
    expect(drop).toHaveLength(1);
    expect(drop[0].title).toMatch(/down 40%/);
  });

  it("refuses plan B when a stay it was free to replace has since been booked, and writes nothing", async () => {
    const { deps } = fakeDeps({ recentPm25: async (lat) => (lat > 18 && lat < 19 ? 95 : 12), normalPm25: async () => 20 });
    await runReplan({ now: new Date("2026-11-10T06:00:00Z"), deps });
    const [p] = await listProposals("2026-11-10");
    // Chiang Mai was only planned when plan B was made; the owner books it the next day.
    const cur = (await readRotation()).stays.find((s) => s.id === "next")!;
    await putStay("next", { place: CNX, kind: "base", status: "booked", start: "2026-12-10", end: "2027-02-20" } as never, cur.updatedAt);
    const before = (await readRotation()).stays.map((s) => s.id).sort();
    const r = await decideProposal(p.id, "accept", { now: new Date("2026-11-11T09:00:00Z") });
    expect("error" in r && r.error).toBe("stale");
    expect((await readRotation()).stays.map((s) => s.id).sort()).toEqual(before);
    expect((await listProposals("2026-11-11"))[0].status).toBe("open");
  });
});
