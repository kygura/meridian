import { describe, expect, it } from "vitest";
import {
  VIBES,
  axisStats,
  buildTarget,
  groupRanking,
  kindFit,
  rankLikeness,
  scoreProfile,
  searchVibes,
  type Profile,
  type Vibe,
} from "./likeness";

// A small synthetic world: one canal city, two lighter canal towns, a mountain town, and a
// spread of plain towns so the averages mean something.
const P = (cityId: string, exp: Profile["exp"], latitude = 45, extra: Partial<Profile> = {}): Profile => ({ cityId, exp, latitude, ...extra });

const venice = P("venice", { heritage: 100, photographed: 100, notable: 95, sea: 90, mountains: 0, water: 0, scale: 35 });
const bruges = P("bruges", { heritage: 85, photographed: 75, notable: 70, sea: 70, mountains: 0, water: 0, scale: 25 });
const haarlem = P("haarlem", { heritage: 70, photographed: 65, notable: 60, sea: 75, mountains: 5, water: 0, scale: 30 });
const alpine = P("alpine", { heritage: 10, photographed: 40, notable: 30, sea: 0, mountains: 95, water: 60, scale: 20 });
const plain = Array.from({ length: 40 }, (_, i) =>
  P(`plain-${i}`, { heritage: 0, photographed: 20 + (i % 10), notable: 20 + (i % 7), sea: i % 4 === 0 ? 60 : 0, mountains: 20 + (i % 15), water: 0, scale: 20 + (i % 20) }),
);
const world = [venice, bruges, haarlem, alpine, ...plain];
const stats = axisStats(world);

describe("scoreProfile", () => {
  it("finds the lighter canal towns alike in shape to Venice, and weaker", () => {
    const t = buildTarget([], [venice], stats)!;
    const v = scoreProfile(venice, t, stats)!;
    const b = scoreProfile(bruges, t, stats)!;
    const a = scoreProfile(alpine, t, stats)!;
    expect(v.likeness).toBeCloseTo(1, 5);
    expect(v.strength).toBeCloseTo(1, 5);
    expect(b.likeness).toBeGreaterThan(0.9);
    expect(b.strength).toBeLessThan(v.strength);
    expect(a.likeness).toBeLessThan(0.3);
  });

  it("skips a profile that covers too little of the target", () => {
    const t = buildTarget([], [venice], stats)!;
    expect(scoreProfile(P("bare", { scale: 30 }), t, stats)).toBeNull();
  });
});

describe("rankLikeness", () => {
  it("makes Venice the source and links the towns to it as echoes, with what they lack", () => {
    const t = buildTarget([], [haarlem], stats)!;
    const { ranked } = rankLikeness(world, t, stats, ["haarlem"]);
    const byId = new Map(ranked.map((r) => [r.cityId, r]));
    expect(ranked[0]!.cityId).toBe("venice");
    expect(byId.get("venice")!.role).toBe("source");
    const h = byId.get("haarlem")!;
    expect(h.seed).toBe(true);
    expect(h.role).toBe("echo");
    expect(h.echoOf).toBe("venice");
    expect(h.lesser).toContain("heritage");
    expect(byId.has("alpine")).toBe(false);
  });

  it("lists sources first, then echoes closest to the real thing", () => {
    const t = buildTarget([], [venice], stats)!;
    const { ranked } = rankLikeness(world, t, stats, ["venice"]);
    const roles = ranked.map((r) => r.role);
    expect(roles.indexOf("echo")).toBeGreaterThan(roles.lastIndexOf("source"));
    expect(ranked.slice(1).map((r) => r.cityId)).toEqual(["bruges", "haarlem"]);
  });

  it("only scores allowed cities, but always keeps the seeds", () => {
    const t = buildTarget([], [haarlem], stats)!;
    const { ranked } = rankLikeness(world, t, stats, ["haarlem"], { allow: (id) => id !== "venice" });
    expect(ranked.find((r) => r.cityId === "venice")).toBeUndefined();
    // Without Venice in the pool, Bruges is the source.
    expect(ranked[0]!.cityId).toBe("bruges");
    expect(ranked.find((r) => r.cityId === "haarlem")!.echoOf).toBe("bruges");
  });
});

describe("vibes", () => {
  const vibe = (id: string) => VIBES.find((v) => v.id === id)!;

  it("ranks the mountain town first for mountains, and leaves the canal towns out", () => {
    const t = buildTarget([vibe("mountains")], [], stats)!;
    const { ranked } = rankLikeness(world, t, stats);
    expect(ranked[0]!.cityId).toBe("alpine");
    expect(ranked.find((r) => r.cityId === "venice")).toBeUndefined();
  });

  it("rules out the wrong kind of place when a vibe sets one", () => {
    const tropical: Vibe = vibe("tropical-coast");
    const t = buildTarget([tropical], [], stats)!;
    // Same coast, ten degrees apart: only the one in the tropics counts.
    const north = P("north", { sea: 100, water: 0 }, 55);
    const south = P("south", { sea: 100, water: 0 }, 12);
    expect(scoreProfile(north, t, stats)!.likeness).toBe(0);
    expect(scoreProfile(south, t, stats)!.likeness).toBeGreaterThan(0.9);
  });

  it("prefers measured climate over latitude", () => {
    const winterSun = vibe("winter-sun").kind!;
    expect(kindFit(P("canaries", {}, 28, { winter: 18 }), winterSun)).toBe(1);
    expect(kindFit(P("cold-coast", {}, 28, { winter: 2 }), winterSun)).toBe(0);
    expect(kindFit(P("unmeasured", {}, 28), winterSun)).toBe(1);
  });

  it("finds vibes by keyword", () => {
    expect(searchVibes("ski").map((v) => v.id)).toContain("snow-mountains");
    expect(searchVibes("unesco").map((v) => v.id)).toEqual(["old-town"]);
    expect(searchVibes("")).toHaveLength(VIBES.length);
  });

  it("needs a vibe or a place", () => {
    expect(buildTarget([], [], stats)).toBeNull();
  });
});

describe("groupRanking", () => {
  it("rolls cities up: a group holding a source is a source", () => {
    const t = buildTarget([], [haarlem], stats)!;
    const { ranked } = rankLikeness(world, t, stats, ["haarlem"]);
    const country: Record<string, string> = { venice: "Italy", bruges: "Belgium", haarlem: "Netherlands" };
    const groups = groupRanking(ranked, (id) => country[id] ?? null);
    expect(groups[0]).toMatchObject({ key: "Italy", role: "source", count: 1 });
    const nl = groups.find((g) => g.key === "Netherlands")!;
    expect(nl.role).toBe("echo");
    expect(nl.echoOf).toBe("Italy");
  });
});
