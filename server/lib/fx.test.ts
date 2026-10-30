import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toMoney, normalizeMoney, setFxFetch, FxUnavailableError, FRANKFURTER_BASE, type FxFetch } from "./fx";

let TMP: string;

function okFetch(rate: number, date: string) {
  return vi.fn<FxFetch>(async () => ({ ok: true, status: 200, json: async () => ({ amount: 1, base: "USD", date, rates: { EUR: rate } }) }));
}
const failingFetch = () => vi.fn<FxFetch>(async () => { throw new Error("ECONNREFUSED"); });

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-fx-"));
  process.env.DATA_DIR = TMP;
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("toMoney", () => {
  it("EUR is identity with no network call", async () => {
    const f = failingFetch();
    setFxFetch(f);
    expect(await toMoney(123.456, "eur", "2024-05-11")).toEqual({ amount: 123.456, currency: "EUR", eur: 123.46, rateDate: "2024-05-11" });
    expect(f).not.toHaveBeenCalled();
  });

  it("converts via Frankfurter and stores the returned business day as rateDate", async () => {
    const f = okFetch(0.9, "2024-05-10"); // Saturday request → Friday rate
    setFxFetch(f);
    const m = await toMoney(100, "USD", "2024-05-11");
    expect(m).toEqual({ amount: 100, currency: "USD", eur: 90, rateDate: "2024-05-10" });
    expect(f).toHaveBeenCalledWith(`${FRANKFURTER_BASE}/2024-05-11?from=USD&to=EUR`);
    const cache = JSON.parse(readFileSync(join(TMP, "cache/fx.json"), "utf-8"));
    expect(cache.rates["2024-05-11|USD"]).toMatchObject({ rate: 0.9, rateDate: "2024-05-10" });
  });

  it("uses only the date part of a datetime", async () => {
    const f = okFetch(0.5, "2024-05-02");
    setFxFetch(f);
    await toMoney(10, "GBP", "2024-05-02T09:40:00Z");
    expect(f).toHaveBeenCalledWith(`${FRANKFURTER_BASE}/2024-05-02?from=GBP&to=EUR`);
  });

  it("cache hit makes no network call", async () => {
    setFxFetch(okFetch(0.9, "2024-05-10"));
    await toMoney(1, "USD", "2024-05-11");
    const f2 = failingFetch();
    setFxFetch(f2);
    expect((await toMoney(50, "USD", "2024-05-11")).eur).toBe(45);
    expect(f2).not.toHaveBeenCalled();
  });

  it("dedupes concurrent fetches for the same key", async () => {
    const f = okFetch(0.9, "2024-05-10");
    setFxFetch(f);
    await Promise.all([toMoney(1, "USD", "2024-05-11"), toMoney(2, "USD", "2024-05-11")]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("network failure falls back to the latest cached rate for that currency", async () => {
    setFxFetch(okFetch(0.8, "2023-01-02"));
    await toMoney(1, "USD", "2023-01-02");
    setFxFetch(okFetch(0.9, "2024-05-10"));
    await toMoney(1, "USD", "2024-05-10");
    setFxFetch(okFetch(0.5, "2024-06-03"));
    await toMoney(1, "GBP", "2024-06-03"); // other currency must not be used
    setFxFetch(failingFetch());
    expect(await toMoney(100, "USD", "2025-01-01")).toEqual({ amount: 100, currency: "USD", eur: 90, rateDate: "2024-05-10" });
  });

  it("a definitive 4xx (or no rate) never falls back to a cached rate; 5xx/429 do", async () => {
    setFxFetch(okFetch(0.92, "2024-05-02"));
    await toMoney(1, "USD", "2024-05-02");
    setFxFetch(vi.fn<FxFetch>(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(toMoney(100, "USD", "1998-06-01")).rejects.toBeInstanceOf(FxUnavailableError);
    setFxFetch(vi.fn<FxFetch>(async () => ({ ok: true, status: 200, json: async () => ({ rates: {} }) })));
    await expect(toMoney(100, "USD", "1998-06-02")).rejects.toBeInstanceOf(FxUnavailableError);
    for (const status of [429, 503]) {
      setFxFetch(vi.fn<FxFetch>(async () => ({ ok: false, status, json: async () => ({}) })));
      expect(await toMoney(100, "USD", "2025-01-01")).toMatchObject({ eur: 92, rateDate: "2024-05-02" });
    }
  });

  it("throws FxUnavailableError with no network and no cached rate", async () => {
    setFxFetch(failingFetch());
    await expect(toMoney(100, "USD", "2024-05-11")).rejects.toBeInstanceOf(FxUnavailableError);
  });

  it("treats a non-ok response or missing rate as unavailable", async () => {
    setFxFetch(vi.fn<FxFetch>(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(toMoney(1, "XXX", "2024-05-11")).rejects.toBeInstanceOf(FxUnavailableError);
    setFxFetch(vi.fn<FxFetch>(async () => ({ ok: true, status: 200, json: async () => ({ rates: {} }) })));
    await expect(toMoney(1, "USD", "2024-05-11")).rejects.toBeInstanceOf(FxUnavailableError);
  });

  it("rejects malformed currency codes", async () => {
    await expect(toMoney(1, "US", "2024-05-11")).rejects.toBeInstanceOf(FxUnavailableError);
  });
});

describe("normalizeMoney", () => {
  it("keeps a Money that already has eur + rateDate", async () => {
    const f = failingFetch();
    setFxFetch(f);
    expect(await normalizeMoney({ amount: 10, currency: "usd", eur: 9.1, rateDate: "2024-01-02" }, "2024-05-11")).toEqual({
      amount: 10, currency: "USD", eur: 9.1, rateDate: "2024-01-02",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fills eur/rateDate from the record date", async () => {
    setFxFetch(okFetch(0.9, "2024-05-10"));
    expect(await normalizeMoney({ amount: 10, currency: "USD" }, "2024-05-11")).toEqual({ amount: 10, currency: "USD", eur: 9, rateDate: "2024-05-10" });
  });
});
