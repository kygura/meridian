import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities, getCityById } from "./cities";
import { setFxFetch } from "./fx";
import { createJourney, getJourney, updateJourney } from "./journal";
import type { JourneyInputRaw } from "./journalSchemas";
import { ensureFingerprint, registerJournalFingerprint, setFingerprintDepsFactory, whenFingerprintsSettled } from "./journalFingerprint";
import { fixtureFingerprintDeps } from "./__fixtures__/journal";
import type { FingerprintDeps } from "./fingerprint";

let TMP: string;
let unregister: () => void;

const TRIP: JourneyInputRaw = {
  title: "Lisbon",
  startDate: "2024-05-10",
  endDate: "2024-05-17",
  stops: [
    {
      cityId: "lisbon-portugal",
      arrive: "2024-05-10",
      depart: "2024-05-17",
      lodging: { name: "Old name", provenance: { source: "manual", confidence: "high" }, cost: { amount: 700, currency: "EUR" } },
    },
  ],
  segments: [],
};
const renamed = (): JourneyInputRaw => ({ ...TRIP, stops: [{ ...TRIP.stops[0]!, lodging: { ...TRIP.stops[0]!.lodging!, name: "New name" } }] });

/** Deps factory whose first `gated` calls block weather until release(); later calls are immediate. */
function gatedFactory(gated = 1, opts: Parameters<typeof fixtureFingerprintDeps>[0] = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  setFingerprintDepsFactory(() => {
    const f = fixtureFingerprintDeps(opts);
    const deps: FingerprintDeps = { ...f.deps, getCity: getCityById };
    if (n++ >= gated) return deps;
    return { ...deps, observedWeather: async (...a) => (await gate, f.deps.observedWeather(...a)) };
  });
  return () => release();
}

beforeAll(() => {
  loadCities();
  unregister = registerJournalFingerprint();
});
afterAll(() => {
  unregister();
  setFingerprintDepsFactory();
});
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-journal-fp-"));
  process.env.DATA_DIR = TMP;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-10", rates: { EUR: 0.9 } }) }));
});
afterEach(async () => {
  await whenFingerprintsSettled();
  setFxFetch();
  setFingerprintDepsFactory();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("fingerprint persistence never reverts un-hashed edits (R8)", () => {
  it("a slow background job finishing after a lodging-name edit keeps the new name", async () => {
    const release = gatedFactory(1);
    const j = await createJourney(TRIP); // job A: blocked
    await updateJourney(j.id, renamed()); // job B: immediate
    await new Promise((r) => setTimeout(r, 20));
    expect((await getJourney(j.id))!.stops[0]!.lodging!.name).toBe("New name");
    release();
    await whenFingerprintsSettled();
    const stored = (await getJourney(j.id))!;
    expect(stored.stops[0]!.lodging!.name).toBe("New name");
    expect(stored.stops[0]!.fingerprint).toBeDefined();
    expect(stored.fingerprint).toBeDefined();
  });

  it("ensureFingerprint racing a lodging-name edit keeps the new name", async () => {
    setFingerprintDepsFactory(() => ({ ...fixtureFingerprintDeps({ weather: "quota" }).deps, getCity: getCityById }));
    const j = await createJourney(TRIP);
    await whenFingerprintsSettled();
    const pending = (await getJourney(j.id))!;
    const release = gatedFactory(1);
    const running = ensureFingerprint(pending); // blocked on weather
    await updateJourney(j.id, renamed());
    await whenFingerprintsSettled();
    release();
    const returned = await running;
    await whenFingerprintsSettled();
    expect(returned.stops[0]!.lodging!.name).toBe("New name");
    expect((await getJourney(j.id))!.stops[0]!.lodging!.name).toBe("New name");
  });
});
