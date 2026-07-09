import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { dirname } from "path";
import { loadCities } from "../lib/cities.js";
import { getDataPath } from "../lib/paths.js";
import { searchPlaces, searchPlacesParams, getSeasonalityParams } from "../lib/agent/tools.js";
import agent from "./agent.js";

beforeAll(() => loadCities());

// AI SDK v4 data-stream part codes we care about (see @ai-sdk/ui-utils).
const TOOL_CALL_CODE = "9";
const TOOL_RESULT_CODE = "a";
const TEXT_CODE = "0";

interface StreamPart {
  code: string;
  value: any;
}

function parseDataStreamLines(body: string): StreamPart[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const idx = line.indexOf(":");
      const code = line.slice(0, idx);
      const value = JSON.parse(line.slice(idx + 1));
      return { code, value };
    });
}

describe("POST /api/agent/chat — mock path emits AI SDK v4 tool parts", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let originalFetch: typeof fetch;
  let expectedTopCityId: string | undefined;
  let cachePathForTop: string | undefined;
  let cacheBackup: string | null = null;

  beforeAll(async () => {
    // Same args parseMockIntent produces for a message with no region/cheap/safe
    // keywords, so we know in advance which city the mock pipeline will fetch
    // images/seasonality for, and can isolate its on-disk image cache.
    const args = searchPlacesParams.parse({ limit: 4 });
    const results = await searchPlaces(args);
    expectedTopCityId = results[0]?.cityId;
    if (expectedTopCityId) {
      cachePathForTop = getDataPath("cache", "images", `${expectedTopCityId}.json`);
    }
  });

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    originalFetch = global.fetch;
    if (cachePathForTop) {
      cacheBackup = existsSync(cachePathForTop) ? readFileSync(cachePathForTop, "utf-8") : null;
      if (existsSync(cachePathForTop)) rmSync(cachePathForTop);
    }

    // Stub Wikipedia/Commons network calls with a deterministic fake summary
    // so get_place_images resolves without hitting the real network.
    global.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("wikipedia.org/api/rest_v1/page/summary")) {
        return new Response(
          JSON.stringify({
            title: "Test City",
            thumbnail: { source: "https://upload.wikimedia.org/thumb.jpg" },
            originalimage: { source: "https://upload.wikimedia.org/full.jpg" },
            content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Test_City" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ query: {} }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalOpenAIKey !== undefined) process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (cachePathForTop) {
      if (cacheBackup !== null) {
        mkdirSync(dirname(cachePathForTop), { recursive: true });
        writeFileSync(cachePathForTop, cacheBackup);
      } else if (existsSync(cachePathForTop)) {
        rmSync(cachePathForTop);
      }
    }
  });

  it("streams tool_call + tool_result parts for search_places, get_place_images, get_seasonality, then text", async () => {
    const res = await agent.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Where should I go next?" }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    const parts = parseDataStreamLines(body);

    const toolCalls = parts.filter((p) => p.code === TOOL_CALL_CODE);
    const toolResults = parts.filter((p) => p.code === TOOL_RESULT_CODE);
    const textParts = parts.filter((p) => p.code === TEXT_CODE);

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBe(toolCalls.length);
    expect(textParts.length).toBeGreaterThan(0);

    // Every tool_call's args parse against the exact zod param schema the
    // real streamText tool loop uses — proves the mock path drives the same
    // tool-core contract as the real path.
    const searchCall = toolCalls.find((p) => p.value.toolName === "search_places");
    expect(searchCall).toBeDefined();
    expect(searchPlacesParams.safeParse(searchCall!.value.args).success).toBe(true);
    expect(typeof searchCall!.value.toolCallId).toBe("string");

    const searchResult = toolResults.find((p) => p.value.toolCallId === searchCall!.value.toolCallId);
    expect(searchResult).toBeDefined();
    expect(Array.isArray(searchResult!.value.result)).toBe(true);
    for (const place of searchResult!.value.result) {
      expect(place).toMatchObject({
        cityId: expect.any(String),
        name: expect.any(String),
        country: expect.any(String),
        lat: expect.any(Number),
        lng: expect.any(Number),
        population: expect.any(Number),
        score: expect.any(Number),
        summaryLine: expect.any(String),
      });
    }

    const seasonCall = toolCalls.find((p) => p.value.toolName === "get_seasonality");
    if (seasonCall) {
      expect(getSeasonalityParams.safeParse(seasonCall.value.args).success).toBe(true);
      const seasonResult = toolResults.find((p) => p.value.toolCallId === seasonCall.value.toolCallId);
      expect(typeof seasonResult!.value.result.available).toBe("boolean");
    }

    const imagesCall = toolCalls.find((p) => p.value.toolName === "get_place_images");
    if (imagesCall) {
      const imagesResult = toolResults.find((p) => p.value.toolCallId === imagesCall.value.toolCallId);
      expect(Array.isArray(imagesResult!.value.result)).toBe(true);
      for (const img of imagesResult!.value.result) {
        expect(img).toMatchObject({
          url: expect.any(String),
          thumbUrl: expect.any(String),
          title: expect.any(String),
          attribution: expect.any(String),
          sourcePage: expect.any(String),
        });
      }
    }
  });

  it("targets an explicitly-named city for seasonality (deterministic city detection)", async () => {
    // Isolate the on-disk image cache for madrid-spain — the stubbed fetch
    // must not leave fake entries behind for the running app.
    const madridCachePath = getDataPath("cache", "images", "madrid-spain.json");
    const madridBackup = existsSync(madridCachePath) ? readFileSync(madridCachePath, "utf-8") : null;

    const res = await agent.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "When is the best time to visit Madrid?" }] }),
    });

    try {
      expect(res.status).toBe(200);
      const parts = parseDataStreamLines(await res.text());

      const searchCall = parts.find((p) => p.code === TOOL_CALL_CODE && p.value.toolName === "search_places");
      expect(searchCall).toBeDefined();
      expect(searchCall!.value.args.query).toBe("Madrid");

      const seasonCall = parts.find((p) => p.code === TOOL_CALL_CODE && p.value.toolName === "get_seasonality");
      expect(seasonCall).toBeDefined();
      expect(seasonCall!.value.args.cityId).toBe("madrid-spain");

      const seasonResult = parts.find(
        (p) => p.code === TOOL_RESULT_CODE && p.value.toolCallId === seasonCall!.value.toolCallId
      );
      expect(seasonResult).toBeDefined();
      expect(typeof seasonResult!.value.result.available).toBe("boolean");
      if (seasonResult!.value.result.available) {
        expect(seasonResult!.value.result.months).toHaveLength(12);
      }
    } finally {
      if (madridBackup !== null) {
        mkdirSync(dirname(madridCachePath), { recursive: true });
        writeFileSync(madridCachePath, madridBackup);
      } else if (existsSync(madridCachePath)) {
        rmSync(madridCachePath);
      }
    }
  });

  it("400s on an invalid body instead of streaming", async () => {
    const res = await agent.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "bogus", content: "x" }] }),
    });
    expect(res.status).toBe(400);
  });
});
