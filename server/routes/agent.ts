import { Hono } from "hono";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { getCityById, getCities } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import type { TickerItem, AgentBrief, City } from "../../src/types.js";

const agent = new Hono();

const CACHE_DIR = join(process.cwd(), "data", "cache");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

const MOCK_TICKER: TickerItem[] = [
  {
    glyph: "alert",
    location: "UKRAINE",
    text: "Air-defense activity around Kyiv overnight.",
    time: "12m",
  },
  {
    glyph: "hazard",
    location: "PHILIPPINES",
    text: "Typhoon approaching N. Luzon.",
    time: "23m",
  },
  {
    glyph: "info",
    location: "JAPAN",
    text: "Yen weakens; tourism at 12-month high.",
    time: "47m",
  },
  {
    glyph: "good",
    location: "ICELAND",
    text: "Aurora Kp7 forecast this week.",
    time: "1h",
  },
  {
    glyph: "alert",
    location: "SUDAN",
    text: "Khartoum corridor remains restricted.",
    time: "1h",
  },
];

function getMockBrief(cityId: string): AgentBrief {
  const city = getCityById(cityId);
  const name = city?.name ?? cityId;
  const country = city?.country ?? "Unknown";
  const score = city ? computeFullScore(city) : undefined;

  return {
    cityId,
    generatedAt: new Date().toISOString(),
    seasonality: `${name} experiences moderate seasonal variation. Peak travel months are typically March-May and September-November.`,
    news: `${name}, ${country} — No major disruptions reported. General conditions are stable for travel and remote work.`,
    costEstimates: `Estimated monthly cost of living in ${name}: $1,200–$2,500 depending on lifestyle. Accommodation: $600–$1,500/mo. Coworking: $100–$250/mo.`,
    recommendations: `${name} is a viable base for digital nomads. Consider checking visa requirements for ${country} and local coworking availability.`,
    score: score?.overall,
  };
}

const REGION_COUNTRIES: Record<string, string[]> = {
  asia: ["Japan", "Thailand", "Vietnam", "Indonesia", "Malaysia", "India", "Philippines", "Korea, South", "Taiwan", "Singapore", "Georgia"],
  europe: ["Portugal", "Spain", "Germany", "France", "Netherlands", "Czechia", "Czech Republic", "Poland", "Italy", "Greece", "Estonia", "Croatia"],
  "latin america": ["Mexico", "Colombia", "Argentina", "Brazil", "Chile", "Peru", "Costa Rica", "Uruguay", "Ecuador"],
  africa: ["South Africa", "Kenya", "Morocco", "Egypt", "Ghana", "Tanzania", "Rwanda"],
  equator: ["Indonesia", "Kenya", "Ecuador", "Colombia", "Brazil", "Uganda", "Singapore", "Malaysia"],
};

function buildMockChat(
  messages: Array<{ role: string; content: string }>
): string {
  const last =
    [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";

  let pool: City[] = getCities();
  let regionLabel = "globally";
  for (const [region, countries] of Object.entries(REGION_COUNTRIES)) {
    if (last.includes(region)) {
      const filtered = pool.filter((c) => countries.includes(c.country));
      if (filtered.length) {
        pool = filtered;
        regionLabel = region === "equator" ? "near the equator" : `in ${region}`;
      }
      break;
    }
  }

  pool = pool.filter((c) => c.population > 500000);
  const cheap = /cheap|afford|budget|cost/.test(last);
  const safe = /safe|secure|stab|risk/.test(last);

  const scored = pool
    .map((c) => ({ c, s: computeFullScore(c) }))
    .sort((a, b) => {
      if (cheap) return b.s.economics - a.s.economics;
      if (safe) return b.s.stability - a.s.stability;
      return b.s.overall - a.s.overall;
    })
    .slice(0, 4);

  const angle = cheap
    ? "ranked by affordability"
    : safe
    ? "ranked by stability"
    : "ranked by overall Meridian score";

  const lines = scored.map(({ c, s }) => {
    const metric = cheap ? s.economics : safe ? s.stability : s.overall;
    const note = cheap
      ? "low cost of living"
      : safe
      ? "strong safety and governance signals"
      : "balanced economics, climate, and nomad infrastructure";
    return `• ${c.name}, ${c.country} — score ${metric}/100, ${note}.`;
  });

  return (
    `Here are the strongest matches ${regionLabel} right now, ${angle}:\n\n` +
    lines.join("\n") +
    `\n\nTap any city below to open its full intelligence brief. ` +
    `(Live AI narration is disabled because OPENAI_API_KEY isn't set — these picks come from the local scoring engine.)`
  );
}

async function streamMockChat(text: string): Promise<Response> {
  const { createDataStreamResponse, formatDataStreamPart } = await import("ai");
  return createDataStreamResponse({
    execute: async (dataStream) => {
      const tokens = text.split(/(\s+)/);
      for (const tok of tokens) {
        if (!tok) continue;
        dataStream.write(formatDataStreamPart("text", tok));
        await new Promise((r) => setTimeout(r, 14));
      }
    },
  });
}

/** POST /api/agent/profile - Generate city intelligence brief */
agent.post("/profile", async (c) => {
  const body = await c.req.json();
  const schema = z.object({ cityId: z.string() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { cityId } = parsed.data;
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }

  // Check cache
  ensureCacheDir();
  const cachePath = join(CACHE_DIR, `${cityId}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < CACHE_TTL) {
        return c.json(cached);
      }
    } catch {
      // Cache corrupted, regenerate
    }
  }

  if (!hasOpenAIKey()) {
    const brief = getMockBrief(cityId);
    writeFileSync(cachePath, JSON.stringify(brief, null, 2));
    return c.json(brief);
  }

  // Use AI SDK for streaming response
  try {
    const { streamText } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");

    const score = computeFullScore(city);

    const result = streamText({
      model: openai("gpt-4o-mini"),
      system: `You are Meridian, a nomadic intelligence analyst. Generate a concise city brief for digital nomads. 
Return a JSON object with these fields: seasonality, news, costEstimates, recommendations.
Each field should be 1-2 sentences. Be specific and actionable.`,
      prompt: `Generate a city intelligence brief for ${city.name}, ${city.country}.
Population: ${city.population.toLocaleString()}
Coordinates: ${city.lat}, ${city.lng}
Meridian Score: ${score.overall}/100 (economics: ${score.economics}, quality: ${score.quality}, climate: ${score.climate}, stability: ${score.stability}, nomadInfra: ${score.nomadInfra})`,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    console.error("[agent/profile] AI error, falling back to mock:", err);
    const brief = getMockBrief(cityId);
    writeFileSync(cachePath, JSON.stringify(brief, null, 2));
    return c.json(brief);
  }
});

/** POST /api/agent/chat - Discovery chat */
agent.post("/chat", async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    messages: z.array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })
    ),
  });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  if (!hasOpenAIKey()) {
    return streamMockChat(buildMockChat(parsed.data.messages));
  }

  try {
    const { streamText } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");

    const result = streamText({
      model: openai("gpt-4o-mini"),
      system: `You are Meridian, a nomadic intelligence assistant. Help users discover cities for remote work and travel.
You have deep knowledge of global cities, visa policies, cost of living, internet infrastructure, safety, and climate.
Be concise, specific, and actionable. Reference real data when possible.`,
      messages: parsed.data.messages,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    console.error("[agent/chat] AI error:", err);
    return c.json(
      { error: "AI service unavailable", message: String(err) },
      503
    );
  }
});

/** POST /api/agent/ticker - Generate ticker items */
agent.post("/ticker", async (c) => {
  if (!hasOpenAIKey()) {
    return c.json(MOCK_TICKER);
  }

  try {
    const { generateText } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");

    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      system: `You are a global events monitor. Return a JSON array of 5-8 ticker items about current global events relevant to travelers and digital nomads.
Each item must have: glyph (one of: "alert", "hazard", "info", "good"), location (country or city name, UPPERCASE), text (one sentence), time (relative time like "12m", "1h", "3h").
Return ONLY the JSON array, no markdown or explanation.`,
      prompt: `Generate current global event ticker items for a nomad intelligence dashboard. Focus on: conflicts, natural disasters, visa changes, currency shifts, infrastructure events, and positive developments. Today is ${new Date().toISOString().split("T")[0]}.`,
    });

    try {
      const items = JSON.parse(text) as TickerItem[];
      return c.json(items);
    } catch {
      console.error("[agent/ticker] Failed to parse AI response, using mock");
      return c.json(MOCK_TICKER);
    }
  } catch (err) {
    console.error("[agent/ticker] AI error, using mock:", err);
    return c.json(MOCK_TICKER);
  }
});

export default agent;
