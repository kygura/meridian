import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dailyJobsState, listDailyJobs, registerDailyJob, runDailyJobs, unregisterDailyJob } from "./dailyJobs";
import { isDailyRunDue, parseDailyAt, startDailyScheduler } from "./scheduler";

let TMP: string;
const added: string[] = [];
const register = (name: string, run: () => unknown) => {
  added.push(name);
  registerDailyJob({ name, run: async () => run() });
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-daily-"));
  process.env.DATA_DIR = TMP;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const n of added.splice(0)) unregisterDailyJob(n);
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.restoreAllMocks();
});

const DAY1 = new Date("2026-11-10T06:20:00Z");
const DAY2 = new Date("2026-11-11T06:20:00Z");

describe("runDailyJobs", () => {
  it("runs every job once per UTC day, whoever asks", async () => {
    const a = vi.fn(() => ({ done: 1 }));
    register("job-a", a);
    const first = await runDailyJobs({ now: DAY1 });
    expect(first).toMatchObject({ day: "2026-11-10", ran: true, results: [{ name: "job-a", ok: true, result: { done: 1 } }] });
    expect(await runDailyJobs({ now: new Date("2026-11-10T23:59:00Z") })).toEqual({ day: "2026-11-10", ran: false, results: [] });
    expect(a).toHaveBeenCalledTimes(1);
    expect((await runDailyJobs({ now: DAY2 })).ran).toBe(true);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers (scheduler tick + cron) run it once", async () => {
    const a = vi.fn();
    register("job-a", a);
    const reports = await Promise.all([runDailyJobs({ now: DAY1 }), runDailyJobs({ now: DAY1 }), runDailyJobs({ now: DAY1 })]);
    expect(reports.filter((r) => r.ran)).toHaveLength(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("force runs again the same day", async () => {
    const a = vi.fn();
    register("job-a", a);
    await runDailyJobs({ now: DAY1 });
    expect((await runDailyJobs({ now: DAY1, force: true })).ran).toBe(true);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("a failing job is reported and does not stop the others", async () => {
    const order: string[] = [];
    register("job-bad", () => {
      order.push("bad");
      throw new Error("kaput");
    });
    register("job-good", () => void order.push("good"));
    const r = await runDailyJobs({ now: DAY1 });
    expect(order).toEqual(["bad", "good"]);
    expect(r.results).toMatchObject([
      { name: "job-bad", ok: false, error: "kaput" },
      { name: "job-good", ok: true },
    ]);
    expect((await dailyJobsState()).lastRun!.results).toHaveLength(2);
  });

  it("registering a name again replaces the job; names are kebab-case", () => {
    register("job-a", () => 1);
    register("job-a", () => 2);
    expect(listDailyJobs().filter((n) => n === "job-a")).toHaveLength(1);
    expect(() => registerDailyJob({ name: "Bad Name", run: () => undefined })).toThrow();
  });
});

describe("scheduler", () => {
  it("parses HH:MM", () => {
    expect(parseDailyAt("06:17")).toBe(377);
    expect(parseDailyAt("0:00")).toBe(0);
    expect(parseDailyAt("23:59")).toBe(1439);
    for (const bad of ["24:00", "6", "06:60", "", undefined]) expect(parseDailyAt(bad)).toBeUndefined();
  });

  it("is due once the time has passed and today hasn't run", () => {
    const at = parseDailyAt("06:17")!;
    expect(isDailyRunDue(new Date("2026-11-10T06:16:00Z"), undefined, at)).toBe(false);
    expect(isDailyRunDue(new Date("2026-11-10T06:17:00Z"), undefined, at)).toBe(true);
    expect(isDailyRunDue(new Date("2026-11-10T22:00:00Z"), "2026-11-09", at)).toBe(true); // catches up after downtime
    expect(isDailyRunDue(new Date("2026-11-10T22:00:00Z"), "2026-11-10", at)).toBe(false);
    expect(isDailyRunDue(new Date("2026-11-11T01:00:00Z"), "2026-11-10", at)).toBe(false); // waits for today's time
  });

  it("does not start on Vercel or when switched off", () => {
    const log = vi.fn();
    expect(startDailyScheduler({ env: { VERCEL: "1" }, log })).toBeUndefined();
    expect(startDailyScheduler({ env: { DAILY_JOBS: "off" }, log })).toBeUndefined();
  });

  it("a tick runs the jobs when due, and only once that day", async () => {
    const a = vi.fn();
    register("job-a", a);
    let now = new Date("2026-11-10T05:00:00Z");
    const s = startDailyScheduler({ env: { DAILY_JOBS_AT: "06:17" }, now: () => now, tickMs: 3_600_000, firstTickMs: 3_600_000, log: () => undefined })!;
    try {
      await s.tick();
      expect(a).not.toHaveBeenCalled();
      now = new Date("2026-11-10T06:18:00Z");
      await s.tick();
      await s.tick();
      expect(a).toHaveBeenCalledTimes(1);
      now = new Date("2026-11-11T06:18:00Z");
      await s.tick();
      expect(a).toHaveBeenCalledTimes(2);
    } finally {
      s.stop();
    }
  });

  it("falls back to the default time on a malformed DAILY_JOBS_AT", () => {
    const log = vi.fn();
    const s = startDailyScheduler({ env: { DAILY_JOBS_AT: "morning" }, log, tickMs: 3_600_000, firstTickMs: 3_600_000 })!;
    s.stop();
    expect(log.mock.calls.flat().join(" ")).toContain("06:17 UTC");
  });
});
