import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { LikenessCityRow, LikenessGroupRow } from "../lib/likeness.js";

let app: Hono;

beforeAll(async () => {
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = (await import("./likeness.js")).default;
});

interface CityBody {
  level: "city";
  counts: { sources: number; echoes: number };
  sources: LikenessCityRow[];
  echoes: LikenessCityRow[];
  target: { highlights: string[] };
}
interface GroupBody {
  level: "region" | "country";
  sources: LikenessGroupRow[];
  echoes: LikenessGroupRow[];
}

const get = async <T>(q: string) => {
  const res = await app.request(q);
  return { status: res.status, body: (await res.json()) as T };
};

describe("GET /api/likeness", () => {
  it("lists the vibes", async () => {
    const { body } = await get<{ vibes: { id: string; label: string }[] }>("/vibes");
    expect(body.vibes.map((v) => v.id)).toContain("old-town");
  });

  it("finds Venice's lighter echoes among the old canal and harbour towns of the Low Countries", async () => {
    const { status, body } = await get<CityBody>("/?like=venice-italy&limit=50");
    expect(status).toBe(200);
    expect(body.sources[0]!.cityId).toBe("venice-italy");
    const echoes = new Map(body.echoes.map((e) => [e.cityId, e]));
    expect(echoes.has("brugge-belgium") || echoes.has("haarlem-netherlands")).toBe(true);
    for (const e of body.echoes) {
      expect(e.role).toBe("echo");
      expect(e.echoOf).toBeDefined();
      expect(e.strength).toBeLessThan(100);
    }
  });

  it("puts the seed in the list even when it is an echo of something stronger", async () => {
    const { body } = await get<CityBody>("/?like=m-laga-spain");
    const all = [...body.sources, ...body.echoes];
    const malaga = all.find((r) => r.cityId === "m-laga-spain")!;
    expect(malaga.seed).toBe(true);
    expect(malaga.likeness).toBe(100);
    // Mediterranean port cities between mountains and sea.
    expect(all.some((r) => ["genoa-italy", "naples-italy", "palermo-italy", "catania-italy", "marseille-france"].includes(r.cityId))).toBe(true);
  });

  it("does not count size as strength unless a vibe asks for it", async () => {
    const { body } = await get<CityBody>("/?like=kyoto-japan");
    expect(body.target.highlights).not.toContain("scale");
  });

  it("puts Alpine regions among the sources of mountains", async () => {
    const { body } = await get<GroupBody>("/?vibe=mountains&level=region&limit=20");
    expect(body.level).toBe("region");
    const names = body.sources.map((s) => s.name).join(" | ");
    expect(names).toMatch(/Tirol|Bolzano|Trento/);
    for (const s of body.sources) expect(s.lead.id).toBeTruthy();
  });

  it("rolls up to countries and keeps to one country with within", async () => {
    const countries = await get<GroupBody>("/?vibe=old-town&level=country");
    expect(countries.body.sources.length).toBeGreaterThan(0);
    const spain = await get<CityBody>("/?vibe=old-town&within=Spain");
    for (const r of [...spain.body.sources, ...spain.body.echoes]) expect(r.country).toBe("Spain");
  });

  it("rejects bad input", async () => {
    expect((await get("/")).status).toBe(400);
    expect((await get("/?vibe=nope")).status).toBe(400);
    expect((await get("/?like=not-a-city")).status).toBe(404);
    expect((await get("/?vibe=coast&level=planet")).status).toBe(400);
    expect((await get("/?vibe=coast&min=200")).status).toBe(400);
  });
});
