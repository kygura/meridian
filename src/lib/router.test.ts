import { describe, it, expect } from "vitest";
import { parseHash } from "./router";

describe("parseHash", () => {
  it("keeps the existing routes", () => {
    expect(parseHash("")).toEqual({ view: "globe" });
    expect(parseHash("#/seasons")).toEqual({ view: "seasons" });
    expect(parseHash("#/trips")).toEqual({ view: "trips", tripId: undefined });
    expect(parseHash("#/trips/trip-1")).toEqual({ view: "trips", tripId: "trip-1" });
  });

  it("parses the journal routes with keywords before :id", () => {
    expect(parseHash("#/journal")).toEqual({ view: "journal", sub: "timeline" });
    expect(parseHash("#/journal/")).toEqual({ view: "journal", sub: "timeline" });
    expect(parseHash("#/journal/inbox")).toEqual({ view: "journal", sub: "inbox" });
    expect(parseHash("#/journal/replay")).toEqual({ view: "journal", sub: "replay", journeyId: undefined, stopIndex: undefined });
    expect(parseHash("#/journal/abc-123")).toEqual({ view: "journal", sub: "detail", journeyId: "abc-123" });
  });

  it("parses the replay suffix used by Find similar", () => {
    expect(parseHash("#/journal/replay/j1")).toEqual({ view: "journal", sub: "replay", journeyId: "j1", stopIndex: undefined });
    expect(parseHash("#/journal/replay/j1/2")).toEqual({ view: "journal", sub: "replay", journeyId: "j1", stopIndex: 2 });
    expect(parseHash("#/journal/replay/j1/0")).toMatchObject({ stopIndex: 0 });
  });

  it("a journey whose id starts with a keyword is still a detail route", () => {
    expect(parseHash("#/journal/inboxes")).toEqual({ view: "journal", sub: "detail", journeyId: "inboxes" });
    expect(parseHash("#/journal/replayed")).toEqual({ view: "journal", sub: "detail", journeyId: "replayed" });
  });

  it("falls back to globe for unknown paths", () => {
    expect(parseHash("#/journal/a/b/c")).toEqual({ view: "globe" });
  });
});
