import { describe, expect, it } from "vitest";
import { likenessQuery, setSourcesSeed, takeSourcesSeed } from "./likenessApi";

describe("likenessQuery", () => {
  it("encodes vibes, places, level and country", () => {
    const q = likenessQuery({ vibes: ["old-town", "coast"], like: ["kyoto-japan"], level: "region", within: "Spain", limit: 10 });
    const params = new URLSearchParams(q.split("?")[1]);
    expect(q.startsWith("/api/likeness?")).toBe(true);
    expect(params.get("vibe")).toBe("old-town,coast");
    expect(params.get("like")).toBe("kyoto-japan");
    expect(params.get("level")).toBe("region");
    expect(params.get("within")).toBe("Spain");
    expect(params.get("limit")).toBe("10");
  });

  it("leaves out what is empty", () => {
    const params = new URLSearchParams(likenessQuery({ vibes: [], like: ["x"], level: "city" }).split("?")[1]);
    expect(params.has("vibe")).toBe(false);
    expect(params.has("within")).toBe(false);
  });
});

describe("sources seed hand-off", () => {
  it("is taken once", () => {
    setSourcesSeed("venice-italy");
    expect(takeSourcesSeed()).toBe("venice-italy");
    expect(takeSourcesSeed()).toBeNull();
  });
});
