import { describe, expect, it } from "vitest";
import { eventTagLabel } from "./eventsApi";

describe("eventTagLabel", () => {
  it("turns a kebab tag into a sentence-case label", () => {
    expect(eventTagLabel("film-festival")).toBe("Film festival");
    expect(eventTagLabel("marathon")).toBe("Marathon");
    expect(eventTagLabel("total-solar-eclipse")).toBe("Total solar eclipse");
  });
});
