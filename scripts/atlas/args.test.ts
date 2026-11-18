import { expect, test } from "vitest";
import { UsageError, flagInt, flagList, flagString, parseArgs, parseBudget, parseMonths } from "./args";
import { parsePlaceRef } from "./place";

test("parseArgs separates positionals from flags", () => {
  const a = parseArgs(["wishlist", "add", "Lisbon", "--tags", "surf,coast", "--avoid=7,8", "--watch", "--json"]);
  expect(a.positionals).toEqual(["wishlist", "add", "Lisbon"]);
  expect(flagList(a, "tags")).toEqual(["surf", "coast"]);
  expect(flagString(a, "avoid")).toBe("7,8");
  expect(a.flags.watch).toBe(true);
  expect(a.flags.json).toBe(true);
});

test("boolean flags do not consume the next token", () => {
  const a = parseArgs(["watch", "--watch", "THAI"]);
  expect(a.positionals).toEqual(["watch", "THAI"]);
});

test("a lone dash is a positional (stdin) and -- ends flag parsing", () => {
  expect(parseArgs(["scan", "-"]).positionals).toEqual(["scan", "-"]);
  expect(parseArgs(["a", "--", "--not-a-flag"]).positionals).toEqual(["a", "--not-a-flag"]);
});

test("a value flag without a value is a usage error", () => {
  expect(() => parseArgs(["seasonal", "--months"])).toThrow(UsageError);
  expect(() => parseArgs(["seasonal", "--months", "--json"])).toThrow(UsageError);
});

test("values may start with < or a single dash", () => {
  expect(flagString(parseArgs(["--budget", "<1500"]), "budget")).toBe("<1500");
  expect(flagInt(parseArgs(["--limit", "10"]), "limit")).toBe(10);
  expect(() => flagInt(parseArgs(["--limit", "ten"]), "limit")).toThrow(UsageError);
});

test("-h sets help", () => {
  expect(parseArgs(["-h"]).flags.help).toBe(true);
});

test("parseMonths validates and sorts", () => {
  expect(parseMonths("2,1,2")).toEqual([1, 2]);
  expect(() => parseMonths("0")).toThrow(UsageError);
  expect(() => parseMonths("13")).toThrow(UsageError);
  expect(() => parseMonths("jan")).toThrow(UsageError);
});

test("parseBudget reads ranges, caps and floors", () => {
  expect(parseBudget("800-1500")).toEqual({ min: 800, max: 1500 });
  expect(parseBudget("800\u20131500")).toEqual({ min: 800, max: 1500 });
  expect(parseBudget("<1500")).toEqual({ max: 1500 });
  expect(parseBudget("1500")).toEqual({ max: 1500 });
  expect(parseBudget("800+")).toEqual({ min: 800 });
  expect(() => parseBudget("1500-800")).toThrow(UsageError);
  expect(() => parseBudget("cheap")).toThrow(UsageError);
});

test("parsePlaceRef: airport code, city id or search query", () => {
  expect(parsePlaceRef("LIS")).toEqual({ iata: "LIS" });
  expect(parsePlaceRef("lisbon-portugal")).toEqual({ cityId: "lisbon-portugal" });
  expect(parsePlaceRef("sao-tome-and-principe")).toEqual({ cityId: "sao-tome-and-principe" });
  expect(parsePlaceRef("Lisbon")).toEqual({ query: "Lisbon" });
  expect(parsePlaceRef("lis")).toEqual({ query: "lis" });
  expect(parsePlaceRef("Port-au-Prince")).toEqual({ query: "Port-au-Prince" });
  expect(parsePlaceRef("Pico Island, Azores")).toEqual({ query: "Pico Island, Azores" });
  expect(parsePlaceRef("LISB")).toEqual({ query: "LISB" });
  expect(() => parsePlaceRef("  ")).toThrow(UsageError);
});
