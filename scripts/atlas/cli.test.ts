import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runCli, getAtPath, nestedPatch, parseConfigValue, type CliDeps } from "./cli";
import { MeridianError, type MeridianClient } from "./client";

function harness(client: Partial<MeridianClient> = {}, files: Record<string, string> = {}, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p] as string;
    },
    readStdin: async () => stdin,
    env: {},
    cwd: () => process.cwd(),
    makeClient: () => ({ baseUrl: "https://m.example", ...client }) as MeridianClient
  };
  return { deps, out, err };
}

test("help and no arguments print usage and exit 0", async () => {
  for (const argv of [[], ["help"], ["scan", "--help"]]) {
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Usage: npm run atlas");
  }
});

test("an unknown command exits 1 with a message on stderr", async () => {
  const h = harness();
  expect(await runCli(["frobnicate"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain('Unknown command "frobnicate"');
});

test("config set builds a nested partial and PATCHes it", async () => {
  let sent: unknown;
  const h = harness({
    patchConfig: async (p: unknown) => {
      sent = p;
      return { config: { hardFilters: { maxStops: 3 } } as never, updatedAt: "now" };
    }
  });
  expect(await runCli(["config", "set", "hardFilters.maxStops", "3"], h.deps)).toBe(0);
  expect(sent).toEqual({ hardFilters: { maxStops: 3 } });
  expect(h.out.join("\n")).toContain("Set hardFilters.maxStops = 3");
});

test("config helpers", () => {
  expect(nestedPatch("a.b.c", [1])).toEqual({ a: { b: { c: [1] } } });
  expect(parseConfigValue('{"min":1}')).toEqual({ min: 1 });
  expect(parseConfigValue("boutique")).toBe("boutique");
  expect(getAtPath({ a: { b: 2 } }, "a.b")).toBe(2);
  expect(() => getAtPath({ a: 1 }, "a.b")).toThrow();
});

test("wishlist add and watch build entries from flags", async () => {
  const sent: unknown[] = [];
  const h = harness({
    upsertWishlist: async (entries: unknown) => {
      sent.push(entries);
      return { entries: [], unresolved: [{ place: { query: "x" }, reason: "no match" }] };
    }
  });
  await runCli(["wishlist", "add", "Lisbon", "--tags", "surf,coast", "--avoid", "7,8", "--notes", "windy", "--scouted"], h.deps);
  await runCli(["watch", "BKK", "--budget", "<1500", "--chat", "42"], h.deps);
  expect(sent[0]).toEqual([
    { place: { query: "Lisbon" }, source: "scouted", intentTags: ["surf", "coast"], avoidMonths: [7, 8], notes: "windy" }
  ]);
  expect(sent[1]).toEqual([{ place: { iata: "BKK" }, source: "wished", watch: { active: true, targetBudgetEur: { max: 1500 }, chatId: "42" } }]);
});

test("wishlist add --unwatch turns the watch off", async () => {
  const sent: unknown[] = [];
  const h = harness({
    upsertWishlist: async (entries: unknown) => {
      sent.push(entries);
      return { entries: [], unresolved: [] };
    }
  });
  await runCli(["wishlist", "add", "BKK", "--unwatch"], h.deps);
  expect(sent[0]).toEqual([{ place: { iata: "BKK" }, source: "wished", watch: { active: false } }]);
});

test("an unresolved place exits 1", async () => {
  const h = harness({ upsertWishlist: async () => ({ entries: [], unresolved: [{ place: { query: "Zzz" }, reason: "no match" }] }) });
  expect(await runCli(["wishlist", "add", "Zzz"], h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("Not resolved: Zzz");
});

test("scan reads a file, posts it and prints a table", async () => {
  let sent: unknown;
  const h = harness(
    {
      scan: async (input: unknown) => {
        sent = input;
        return {
          runId: "run1",
          scored: [
            {
              flight: { id: "MAD-LIS-1", destinationName: "Lisbon", priceEur: 80 },
              annotation: { distortion: false },
              baseline: { route: "MAD-LIS", median: 120, p25: 100, count: 5, thin: false },
              priceVsMedianPct: -33.3,
              composite: 7.9,
              opportunity: true,
              opportunityReason: "price under 85% of median",
              baselineDeal: true,
              gates: { passed: true, failures: [], warnings: [] }
            }
          ],
          rejected: [{ flight: { id: "MAD-X-1", priceEur: 3000 }, reasons: ["over budget"] }],
          watchHits: [],
          selection: { top: "MAD-LIS-1", alternative: null }
        } as never;
      }
    },
    { "scan.json": '{"mode":"scheduled","origin":"MAD","flights":[],"annotations":[]}' }
  );
  expect(await runCli(["scan", "scan.json"], h.deps)).toBe(0);
  expect(sent).toEqual({ mode: "scheduled", origin: "MAD", flights: [], annotations: [] });
  const text = h.out.join("\n");
  expect(text).toContain("-33.3%");
  expect(text).toContain("baseline deal, opportunity");
  expect(text).toContain("Selection: top MAD-LIS-1");
  expect(text).toContain("over budget");
});

test("scan --json prints the raw response", async () => {
  const response = { runId: "r", scored: [], rejected: [], watchHits: [], selection: { top: null, alternative: null } };
  const h = harness({ scan: async () => response as never }, {}, '{"mode":"query","origin":"MAD","flights":[],"annotations":[]}');
  expect(await runCli(["scan", "-", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out.join("\n"))).toEqual(response);
});

test("notify builds a payload from flags and a body file", async () => {
  let sent: unknown;
  const h = harness(
    {
      notify: async (i: unknown) => {
        sent = i;
        return { notice: {}, deduped: false, deliveries: [{ channel: "telegram", ok: true }] } as never;
      }
    },
    { "digest.txt": "Three deals this week." }
  );
  expect(await runCli(["notify", "--kind", "digest", "--title", "Weekly digest", "--body-file", "digest.txt", "--dedupe-key", "wk1"], h.deps)).toBe(0);
  expect(sent).toEqual({ kind: "digest", title: "Weekly digest", body: "Three deals this week.", dedupeKey: "wk1" });
  expect(await runCli(["notify", "--kind", "bogus", "--title", "x"], h.deps)).toBe(1);
});

test("server errors exit 1 with the message and body on stderr", async () => {
  const h = harness({
    runs: async () => {
      throw new MeridianError(401, { error: "unauthorized" }, "GET /api/atlas/runs failed: 401 unauthorized");
    }
  });
  expect(await runCli(["runs"], h.deps)).toBe(1);
  const text = h.err.join("\n");
  expect(text).toContain("401 unauthorized");
  expect(text).toContain('"error": "unauthorized"');
});

test("import --dry-run needs no credentials and sends nothing", async () => {
  const h = harness();
  h.deps.makeClient = () => {
    throw new Error("client must not be created");
  };
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy");
  expect(await runCli(["import", "--dry-run", "--dir", dir], h.deps)).toBe(0);
  expect(h.out.join("\n")).toContain("Dry run, nothing sent.");
});

// ── Season research, ideas, priority, run ────────────────────────────

const ideaContext = {
  today: "2026-11-18",
  origin: { cityId: "madrid-spain", name: "Madrid", country: "Spain", iata: "MAD", source: "fallback" },
  fallbackOrigins: ["MAD"],
  rotation: { current: null, next: null, daysLeft: null, nextMoveDate: null },
  windows: { a: { from: "2026-12-01", to: "2026-12-15" }, b: { from: "2027-01-15", to: "2027-03-01" } },
  wishlist: [],
  ideas: [
    { window: "a", from: "2026-12-01", to: "2026-12-15", cityId: "sal-cape-verde", name: "Sal", country: "Cabo Verde", iata: "SAL", score: 71.2, km: 3000, parts: {}, reasons: ["comfort 80 in Dec", "researched quiet 4/5"] },
    { window: "b", from: "2027-01-15", to: "2027-03-01", cityId: "lombok-indonesia", name: "Lombok", country: "Indonesia", iata: "LOP", score: 64, km: 12000, parts: {}, reasons: ["comfort 70 in Jan-Feb"] }
  ],
  researchNeeded: [{ cityId: "sal-cape-verde", name: "Sal", priority: 4, months: [12, 1] }],
  recentlyScouted: [],
  lastRuns: [],
  routine: { configured: false }
};

test("context shows trip ideas and research needed briefly", async () => {
  const h = harness({ context: async () => ideaContext as never });
  expect(await runCli(["context"], h.deps)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toContain("Trip ideas (2)");
  expect(text).toContain("A: Sal 71.20");
  expect(text).toContain("Research needed (1)");
  expect(text).toContain("Sal (Dec, Jan)");
  expect(text).toContain("Routine trigger: not configured");
});

test("ideas prints the ideas grouped by window with reasons", async () => {
  const h = harness({ context: async () => ideaContext as never });
  expect(await runCli(["ideas"], h.deps)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toContain("Window A: 2026-12-01 to 2026-12-15");
  expect(text).toContain("Window B: 2027-01-15 to 2027-03-01");
  expect(text).toContain("1. Sal, Cabo Verde [SAL]  score 71.20");
  expect(text).toContain("comfort 80 in Dec; researched quiet 4/5");
});

test("research prints the places that need research", async () => {
  const h = harness({ context: async () => ideaContext as never });
  expect(await runCli(["research"], h.deps)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toContain("sal-cape-verde");
  expect(text).toContain("Dec, Jan");
  const json = harness({ context: async () => ideaContext as never });
  await runCli(["research", "--json"], json.deps);
  expect(JSON.parse(json.out.join("\n"))).toEqual(ideaContext.researchNeeded);
});

test("signals lists stored research, optionally for one city", async () => {
  let asked: string | undefined = "unset";
  const h = harness({
    signals: async (cityId?: string) => {
      asked = cityId;
      return {
        signals: [{ cityId: "sal-cape-verde", month: 12, quiet: 4, conditions: 5, events: [{ title: "Festival" }], sources: [], researchedAt: "2026-11-01T10:00:00.000Z" }]
      };
    }
  });
  expect(await runCli(["signals", "--city", "sal-cape-verde"], h.deps)).toBe(0);
  expect(asked).toBe("sal-cape-verde");
  const text = h.out.join("\n");
  expect(text).toContain("4/5");
  expect(text).toContain("Festival");
  await runCli(["signals"], h.deps);
  expect(asked).toBeUndefined();
});

test("signals add accepts a wrapped object or a bare array, from a file or stdin", async () => {
  const sent: unknown[] = [];
  const signal = { place: { iata: "SAL" }, month: 12, quiet: 4 };
  const h = harness(
    {
      addSignals: async (list: unknown) => {
        sent.push(list);
        return { stored: 1, unresolved: [{ place: { query: "Nowhere" }, reason: "No city matches 'Nowhere'" }] };
      }
    },
    { "s.json": JSON.stringify({ signals: [signal] }) },
    JSON.stringify([signal])
  );
  expect(await runCli(["signals", "add", "s.json"], h.deps)).toBe(0);
  expect(await runCli(["signals", "add", "-"], h.deps)).toBe(0);
  expect(sent).toEqual([[signal], [signal]]);
  expect(h.out.join("\n")).toContain("Stored 1 signal.");
  expect(h.out.join("\n")).toContain("Not resolved: Nowhere");
  expect(await runCli(["signals", "add"], h.deps)).toBe(1);
  expect(await runCli(["signals", "bogus"], h.deps)).toBe(1);
});

test("signals add rejects a JSON object without a signals list", async () => {
  const h = harness({}, { "bad.json": '{"foo":1}' });
  expect(await runCli(["signals", "add", "bad.json"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("signals");
});

test("wishlist add --priority is sent and range-checked", async () => {
  const sent: unknown[] = [];
  const h = harness({
    upsertWishlist: async (entries: unknown) => {
      sent.push(entries);
      return { entries: [], unresolved: [] };
    }
  });
  expect(await runCli(["wishlist", "add", "MAD", "--priority", "5"], h.deps)).toBe(0);
  expect(sent[0]).toEqual([{ place: { iata: "MAD" }, source: "wished", priority: 5 }]);
  expect(await runCli(["wishlist", "add", "MAD", "--priority", "6"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("--priority");
});

test("wishlist set builds a PATCH from the flags", async () => {
  const calls: { cityId: string; patch: unknown }[] = [];
  const place = { cityId: "sal-cape-verde", name: "Sal", country: "Cabo Verde", source: "wished", intentTags: ["surf"], avoidMonths: [7, 8], priority: 4 };
  const h = harness({
    patchWishlist: async (cityId: string, patch: unknown) => {
      calls.push({ cityId, patch });
      return { entry: place } as never;
    }
  });
  expect(
    await runCli(["wishlist", "set", "sal-cape-verde", "--priority", "4", "--avoid", "7,8", "--tags", "surf", "--notes", "windy", "--budget", "<900", "--chat", "42"], h.deps)
  ).toBe(0);
  expect(calls[0]).toEqual({
    cityId: "sal-cape-verde",
    patch: { priority: 4, avoidMonths: [7, 8], intentTags: ["surf"], notes: "windy", watch: { active: true, targetBudgetEur: { max: 900 }, chatId: "42" } }
  });
  expect(h.out.join("\n")).toContain("Updated Sal");
});

test("wishlist set --unwatch sends watch null and an empty --notes clears the notes", async () => {
  const calls: unknown[] = [];
  const h = harness({
    patchWishlist: async (_id: string, patch: unknown) => {
      calls.push(patch);
      return { entry: { cityId: "x", name: "X", country: "Y", source: "wished", intentTags: [], avoidMonths: [], priority: 3 } } as never;
    }
  });
  await runCli(["wishlist", "set", "x-y", "--unwatch"], h.deps);
  await runCli(["wishlist", "set", "x-y", "--notes", ""], h.deps);
  expect(calls).toEqual([{ watch: null }, { notes: null }]);
});

test("wishlist set needs a city id and at least one field", async () => {
  const h = harness({});
  expect(await runCli(["wishlist", "set"], h.deps)).toBe(1);
  expect(await runCli(["wishlist", "set", "x-y"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("at least one of");
});

test("a 404 from wishlist set exits 1", async () => {
  const h = harness({
    patchWishlist: async () => {
      throw new MeridianError(404, { error: "not_found" }, "PATCH /api/atlas/wishlist/x-y failed: 404 not_found");
    }
  });
  expect(await runCli(["wishlist", "set", "x-y", "--priority", "2"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("404");
});

test("run sends the mode and text and prints the started run", async () => {
  let sent: unknown;
  const h = harness({
    fire: async (input: unknown) => {
      sent = input;
      return { run: { id: "fire_1", kind: "fire", status: "fired", mode: "research", at: "2026-11-18T10:00:00.000Z", origin: null, counts: {} } } as never;
    }
  });
  expect(await runCli(["run", "--mode", "research", "--text", "focus on Azores"], h.deps)).toBe(0);
  expect(sent).toEqual({ mode: "research", text: "focus on Azores" });
  expect(h.out.join("\n")).toContain("Run fire_1 (research) started.");
  await runCli(["run"], h.deps);
  expect(sent).toEqual({ mode: "scan" });
});

test("run exits 1 and prints the detail when the trigger is not set up", async () => {
  const h = harness({
    fire: async () =>
      ({
        run: { id: "fire_2", kind: "fire", status: "failed", detail: "ATLAS_ROUTINE_FIRE_URL and ATLAS_ROUTINE_TOKEN are not set on the server.", mode: "scan", at: "2026-11-18T10:00:00.000Z", origin: null, counts: {} }
      }) as never
  });
  expect(await runCli(["run"], h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("recorded as failed");
  expect(h.err.join("\n")).toContain("ATLAS_ROUTINE_FIRE_URL");
});

test("run rejects an unknown mode", async () => {
  const h = harness({});
  expect(await runCli(["run", "--mode", "weekly"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("--mode expects");
});

test("import without --dir explains what to pass", async () => {
  const h = harness();
  expect(await runCli(["import"], h.deps)).toBe(1);
  expect(h.err.join("\n")).toContain("--dir");
  expect(h.err.join("\n")).toContain("legacy folder");
});

test("help lists the new commands", async () => {
  const h = harness();
  await runCli(["help"], h.deps);
  const text = h.out.join("\n");
  for (const needle of ["signals add", "ideas", "research", "wishlist set", "run [--mode", "--priority", "import --dir <path>"]) {
    expect(text).toContain(needle);
  }
});
