import { Hono } from "hono";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getCityById, getCities, searchCities } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { ensureDataDir } from "../lib/paths.js";
import { getFlightEstimate } from "../lib/flightSearch.js";
import type { TickerItem, AgentBrief, City, CityResearch, NearbyDestination, TripOption, TripNode, TripEstimate } from "../../src/types.js";

const agent = new Hono();

const CACHE_DIR = ensureDataDir("cache");
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours for research (more current)
const BRIEF_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for simple briefs

function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

const MOCK_TICKER: TickerItem[] = [
  { glyph: "alert", location: "UKRAINE", text: "Air-defense activity around Kyiv overnight.", time: "12m" },
  { glyph: "hazard", location: "PHILIPPINES", text: "Typhoon approaching N. Luzon.", time: "23m" },
  { glyph: "info", location: "JAPAN", text: "Yen weakens; tourism at 12-month high.", time: "47m" },
  { glyph: "good", location: "ICELAND", text: "Aurora Kp7 forecast this week.", time: "1h" },
  { glyph: "alert", location: "SUDAN", text: "Khartoum corridor remains restricted.", time: "1h" },
];

// ── Haversine distance ──────────────────────────────────────────────

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aVal = sinLat * sinLat + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

function formatDistance(km: number): string {
  if (km < 100) return `${Math.round(km)} km`;
  return `${Math.round(km / 100) * 100} km`;
}

// ── Nearby destination finder ────────────────────────────────────────

function findNearbyDestinations(city: City, maxCount = 6): NearbyDestination[] {
  const all = getCities()
    .filter((c) => c.id !== city.id && c.population > 200000)
    .map((c) => {
      const dist = haversineKm(city, c);
      const score = computeFullScore(c);
      return { city: c, dist, score };
    })
    .filter((e) => e.dist < 4000 && e.dist > 100)
    .sort((a, b) => {
      // Blend proximity with score quality
      const aRank = a.score.overall * 0.6 + (1 - a.dist / 4000) * 40;
      const bRank = b.score.overall * 0.6 + (1 - b.dist / 4000) * 40;
      return bRank - aRank;
    })
    .slice(0, maxCount);

  const reasons = [
    "Strong nomad infrastructure",
    "Affordable cost of living",
    "Excellent connectivity",
    "High safety rating",
    "Great seasonal timing",
    "Vibrant coworking scene",
  ];

  return all.map((e, i) => ({
    cityId: e.city.id,
    name: e.city.name,
    country: e.city.country,
    iata: e.city.iata,
    lat: e.city.lat,
    lng: e.city.lng,
    distance: formatDistance(e.dist),
    reason: e.score.overall >= 70 ? reasons[i % reasons.length] : "Good overall score",
  }));
}

// ── Deterministic mock pricing (placeholder until a real flight/stay
// provider is wired in — same shape real data will fill in later) ──

function seededRand(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

function estimateForOption(id: string, nodes: TripNode[]): TripEstimate {
  let totalKm = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    totalKm += haversineKm(nodes[i], nodes[i + 1]);
  }

  const rPrice = seededRand(id + ":price");
  const rStart = seededRand(id + ":start");
  const rLen = seededRand(id + ":len");

  const base = 60 + totalKm * 0.045;
  const priceEstimate = Math.round((base + rPrice * base * 0.5) / 5) * 5;

  const startOffsetDays = 14 + Math.round(rStart * 60); // 14–74 days out
  const tripLengthDays = 3 + Math.round(rLen * 8); // 3–11 days
  const start = new Date(Date.now() + startOffsetDays * 86400000);
  const end = new Date(start.getTime() + tripLengthDays * 86400000);

  return {
    priceEstimate,
    currency: "USD",
    dateRange: {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    },
    source: "mock",
  };
}

// Default home base for real flight pricing — one of the user's three
// starting airports (LPA / AGP / MAD); overridable per-request.
const DEFAULT_ORIGIN_IATA = "MAD";

// Prices the home-base -> first-destination leg with a real provider
// (Duffel, falling back to SerpAPI) and overrides the mock estimate when a
// quote comes back. Leaves the mock in place (source: "mock") on any
// failure or when no provider key is configured, so the UI always has a
// number to show.
async function enrichEstimateWithRealPricing(
  estimate: TripEstimate,
  originIata: string,
  destinationIata: string | undefined
): Promise<TripEstimate> {
  if (!destinationIata || destinationIata === originIata) return estimate;

  const real = await getFlightEstimate({
    originIata,
    destinationIata,
    departureDate: estimate.dateRange.start,
  });
  if (!real) return estimate;

  return {
    ...estimate,
    priceEstimate: Math.round(real.priceAmount),
    currency: real.currency,
    source: real.source,
    dealRating: real.dealRating,
  };
}

// ── Trip option generator ───────────────────────────────────────────

async function generateTripOptions(city: City, originIata: string): Promise<TripOption[]> {
  const nearby = findNearbyDestinations(city, 12);
  const options: TripOption[] = [];

  const push = async (opt: Omit<TripOption, "estimate">) => {
    const mock = estimateForOption(opt.id, opt.nodes);
    const estimate = await enrichEstimateWithRealPricing(mock, originIata, opt.nodes[0]?.iata);
    options.push({ ...opt, estimate });
  };

  // Single-hop: just the city itself as a solo destination
  await push({
    id: `trip-solo-${city.id}`,
    label: `Solo stay in ${city.name}`,
    type: "single",
    nodes: [{
      cityId: city.id,
      name: city.name,
      iata: city.iata,
      lat: city.lat,
      lng: city.lng,
    }],
    highlight: `Base yourself in ${city.name} — explore the city and surrounding region`,
  });

  // Single-hop: top 3 nearby as standalone destinations
  for (const dest of nearby.slice(0, 3)) {
    await push({
      id: `trip-single-${dest.cityId}`,
      label: `${city.name} → ${dest.name}`,
      type: "single",
      nodes: [
        { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng },
        { cityId: dest.cityId, name: dest.name, iata: dest.iata, lat: dest.lat, lng: dest.lng },
      ],
      totalDistance: dest.distance,
      highlight: dest.reason,
    });
  }

  // Multi-hop: 3-city routes (hub + 2 spokes)
  if (nearby.length >= 2) {
    // Route 1: closest high-score pair
    const pair1 = nearby.slice(0, 2);
    await push({
      id: `trip-multi-1-${city.id}`,
      label: `${city.name} → ${pair1[0].name} → ${pair1[1].name}`,
      type: "multi-hop",
      nodes: [
        { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng },
        { cityId: pair1[0].cityId, name: pair1[0].name, iata: pair1[0].iata, lat: pair1[0].lat, lng: pair1[0].lng },
        { cityId: pair1[1].cityId, name: pair1[1].name, iata: pair1[1].iata, lat: pair1[1].lat, lng: pair1[1].lng },
      ],
      highlight: `3-city loop: ${pair1[0].reason.toLowerCase()}, ${pair1[1].reason.toLowerCase()}`,
    });

    // Route 2: different pair for variety
    if (nearby.length >= 4) {
      const pair2 = nearby.slice(2, 4);
      await push({
        id: `trip-multi-2-${city.id}`,
        label: `${city.name} → ${pair2[0].name} → ${pair2[1].name}`,
        type: "multi-hop",
        nodes: [
          { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng },
          { cityId: pair2[0].cityId, name: pair2[0].name, iata: pair2[0].iata, lat: pair2[0].lat, lng: pair2[0].lng },
          { cityId: pair2[1].cityId, name: pair2[1].name, iata: pair2[1].iata, lat: pair2[1].lat, lng: pair2[1].lng },
        ],
        highlight: `Alternate route: ${pair2[0].reason.toLowerCase()}, ${pair2[1].reason.toLowerCase()}`,
      });
    }
  }

  return options;
}

// ── Fallback research (no AI key) ───────────────────────────────────

function buildFallbackResearch(city: City): CityResearch {
  const score = computeFullScore(city);
  const nearby = findNearbyDestinations(city);

  const country = city.country;
  const name = city.name;

  // Use score ranges to generate realistic-ish defaults
  const isAffordable = score.economics >= 60;
  const isSafe = score.stability >= 65;
  const hasGoodInternet = score.nomadInfra >= 55;

  return {
    cityId: city.id,
    generatedAt: new Date().toISOString(),
    summary: `${name}, ${country} — Population ${city.population.toLocaleString()}. Meridian score ${score.overall}/100. ${
      isAffordable ? "Affordable cost of living relative to global averages." : "Cost of living is above global average."
    } ${isSafe ? "Generally stable and safe for travelers." : "Exercise caution and research current conditions before visiting."} ${
      hasGoodInternet ? "Good digital infrastructure for remote work." : "Internet infrastructure may be limited for remote work needs."
    }`,
    livingConditions: {
      title: "Living Conditions",
      items: [
        isAffordable
          ? `Rental prices in ${name} are below the global median — expect to pay significantly less than Western European or North American cities for comparable accommodation.`
          : `${name} commands premium rental prices typical of major urban centers. Central districts carry a significant premium over suburban areas.`,
        isSafe
          ? `${country} ranks well on global peace indices. Standard urban precautions apply as in any major city.`
          : `Research current safety conditions for ${country} before committing. Some areas may require extra caution.`,
        `Healthcare availability in ${name} is ${score.quality >= 60 ? "generally adequate with both public and private options" : "varied — private healthcare is recommended for visitors"}.`,
        `Air quality in ${name} is ${score.climate >= 60 ? "typically good" : "can be a concern in certain seasons"}. ${Math.abs(city.lat) < 30 ? "Tropical climate zone with high humidity." : Math.abs(city.lat) < 50 ? "Temperate climate with seasonal variation." : "Northern climate with cold winters."}`,
      ],
    },
    costBreakdown: {
      rent: isAffordable ? "$300–$800/mo (1BR city center)" : "$800–$2,000/mo (1BR city center)",
      food: isAffordable ? "$200–$400/mo (local diet)" : "$400–$800/mo (mixed diet)",
      transport: "$40–$120/mo (public transit)",
      coworking: hasGoodInternet ? "$80–$200/mo (hot desk)" : "$50–$150/mo (limited availability)",
      healthcare: "$30–$100/mo (basic insurance)",
      totalBudget: isAffordable ? "$700–$1,600/mo" : "$1,400–$3,200/mo",
      currency: city.currency || "Local currency (verify)",
    },
    visa: {
      touristVisa: `Check ${country} entry requirements for your nationality — many countries offer 30–90 day tourist visas.`,
      visaOnArrival: `Research whether ${country} offers visa-on-arrival for your passport.`,
      eVisa: `Many countries now offer e-visa applications — check ${country}'s official immigration portal.`,
      digitalNomadVisa: score.nomadInfra >= 55
        ? `${country} may offer or be developing a digital nomad visa program — check current status.`
        : `Digital nomad visa programs may not yet be available in ${country}.`,
      commonPassportNotes: "Visa requirements vary significantly by nationality. EU/US/UK/AU/CA passport holders generally have the most options.",
    },
    connectivity: {
      avgDownloadMbps: hasGoodInternet ? "40–100 Mbps (fixed)" : "5–30 Mbps (fixed)",
      mobileCoverage: hasGoodInternet ? "4G/5G widely available in urban areas" : "4G in urban core, limited outside",
      coworkingSpaces: hasGoodInternet ? "5–15 spaces in city center area" : "1–3 spaces, may be limited",
      cafeWifi: hasGoodInternet ? "Reliable in most central cafes and restaurants" : "Available but inconsistent outside central areas",
    },
    safetyNotes: [
      isSafe ? "Low violent crime rate by global standards" : "Research current safety conditions thoroughly",
      "Standard urban precautions: guard valuables, avoid poorly lit areas at night",
      "Register with your embassy and keep copies of important documents",
      "Check travel advisories from your government before departure",
    ],
    seasonalAdvice: `Best visiting months depend on latitude. ${Math.abs(city.lat) < 23 ? "Tropical zone: December–March typically drier." : Math.abs(city.lat) < 45 ? "Temperate: April–June and September–November offer pleasant weather." : "Northern: June–August for longest daylight; December–February for winter activities."} Current month: consider seasonal tourism pricing and weather patterns.`,
    nearbyDestinations: nearby,
  };
}

// ── AI-powered research ──────────────────────────────────────────────

async function buildAIResearch(city: City): Promise<CityResearch> {
  const score = computeFullScore(city);
  const nearby = findNearbyDestinations(city);
  const nearbyNames = nearby.slice(0, 4).map((n) => `${n.name}, ${n.country}`).join("; ");

  const { generateText } = await import("ai");
  const { openai } = await import("@ai-sdk/openai");

  const prompt = `Research the city of ${city.name}, ${city.country} for a digital nomad / remote worker audience. Today's date: ${new Date().toISOString().split("T")[0]}.

City data:
- Population: ${city.population.toLocaleString()}
- Coordinates: ${city.lat}, ${city.lng}
- Meridian Score: ${score.overall}/100 (economics: ${score.economics}, quality: ${score.quality}, climate: ${score.climate}, stability: ${score.stability}, nomadInfra: ${score.nomadInfra})
- Nearby destinations worth considering: ${nearbyNames}

Return a JSON object with exactly these fields (no markdown, no code fences, just raw JSON):

{
  "summary": "2-3 sentence overview of the city for someone considering living there short-term",
  "livingConditions": {
    "title": "Living Conditions",
    "items": ["4 specific, factual observations about housing, air quality, healthcare access, and lifestyle in this city — be specific to ${city.name}, not generic"]
  },
  "costBreakdown": {
    "rent": "realistic monthly rent range for 1BR in city center (e.g., '$400-700/mo')",
    "food": "realistic monthly food budget (e.g., '$200-400/mo')",
    "transport": "realistic monthly transport cost",
    "coworking": "realistic monthly coworking cost",
    "healthcare": "realistic monthly basic insurance cost for a foreigner",
    "totalBudget": "total realistic monthly budget range for a nomad",
    "currency": "local currency name"
  },
  "visa": {
    "touristVisa": "specific tourist visa info for ${city.country}",
    "visaOnArrival": "which nationalities get visa on arrival, if any",
    "eVisa": "e-visa availability and process",
    "digitalNomadVisa": "digital nomad visa status in ${city.country}",
    "commonPassportNotes": "notes for EU/US/UK/AU/CA passport holders"
  },
  "connectivity": {
    "avgDownloadMbps": "realistic average fixed broadband speed (e.g., '45-80 Mbps')",
    "mobileCoverage": "4G/5G availability specifics",
    "coworkingSpaces": "number and names of notable coworking spaces if known",
    "cafeWifi": "quality of cafe wifi"
  },
  "safetyNotes": ["3-4 specific safety observations for this city"],
  "seasonalAdvice": "when is the best time to visit, what to expect weather-wise, any seasonal events or warnings",
  "nearbyDestinations": []
}

Be specific to ${city.name}, ${city.country}. Use real price ranges and real information. Do not give generic advice. If you're uncertain about a specific number, give your best estimate with a range.`;

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    system: "You are Meridian, a nomadic intelligence analyst. You provide detailed, specific, and actionable intelligence about cities for digital nomads and remote workers. Always return valid JSON with no markdown formatting.",
    prompt,
    temperature: 0.3,
    maxTokens: 2000,
  });

  try {
    const parsed = JSON.parse(text);
    // Merge in computed nearby destinations (AI doesn't have our city DB)
    parsed.nearbyDestinations = nearby;
    parsed.cityId = city.id;
    parsed.generatedAt = new Date().toISOString();
    return parsed as CityResearch;
  } catch {
    console.error("[agent/research] Failed to parse AI response, using fallback");
    return buildFallbackResearch(city);
  }
}

// ── Mock chat (unchanged) ───────────────────────────────────────────

const REGION_COUNTRIES: Record<string, string[]> = {
  asia: ["Japan", "Thailand", "Vietnam", "Indonesia", "Malaysia", "India", "Philippines", "Korea, South", "Taiwan", "Singapore", "Georgia"],
  europe: ["Portugal", "Spain", "Germany", "France", "Netherlands", "Czechia", "Czech Republic", "Poland", "Italy", "Greece", "Estonia", "Croatia"],
  "latin america": ["Mexico", "Colombia", "Argentina", "Brazil", "Chile", "Peru", "Costa Rica", "Uruguay", "Ecuador"],
  africa: ["South Africa", "Kenya", "Morocco", "Egypt", "Ghana", "Tanzania", "Rwanda"],
  equator: ["Indonesia", "Kenya", "Ecuador", "Colombia", "Brazil", "Uganda", "Singapore", "Malaysia"],
};

function buildMockChat(messages: Array<{ role: string; content: string }>): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";

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

  const angle = cheap ? "ranked by affordability" : safe ? "ranked by stability" : "ranked by overall Meridian score";

  const lines = scored.map(({ c, s }) => {
    const metric = cheap ? s.economics : safe ? s.stability : s.overall;
    const note = cheap ? "low cost of living" : safe ? "strong safety and governance signals" : "balanced economics, climate, and nomad infrastructure";
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

// ── Routes ──────────────────────────────────────────────────────────

/** POST /api/agent/research - Deep structured research for a city */
agent.post("/research", async (c) => {
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

  const fresh = c.req.query("fresh") === "true";

  // Check cache (unless fresh requested)
  if (!fresh) {
    const cachePath = join(CACHE_DIR, `research-${cityId}.json`);
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
  }

  let research: CityResearch;

  if (hasOpenAIKey()) {
    try {
      research = await buildAIResearch(city);
    } catch (err) {
      console.error("[agent/research] AI error, falling back:", err);
      research = buildFallbackResearch(city);
    }
  } else {
    research = buildFallbackResearch(city);
  }

  const cachePath = join(CACHE_DIR, `research-${cityId}.json`);
  writeFileSync(cachePath, JSON.stringify(research, null, 2));
  return c.json(research);
});

/** POST /api/agent/trip-options - Generate trip route suggestions */
agent.post("/trip-options", async (c) => {
  const body = await c.req.json();
  const schema = z.object({ cityId: z.string(), originIata: z.string().length(3).optional() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { cityId, originIata } = parsed.data;
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }

  const options = await generateTripOptions(city, (originIata ?? DEFAULT_ORIGIN_IATA).toUpperCase());
  return c.json({ cityId, options });
});

/** POST /api/agent/profile - Legacy city intelligence brief (kept for compat) */
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
  const cachePath = join(CACHE_DIR, `${cityId}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < BRIEF_CACHE_TTL) {
        return c.json(cached);
      }
    } catch {
      // Cache corrupted, regenerate
    }
  }

  // Profile now just returns a subset of the research endpoint
  let research: CityResearch;
  if (hasOpenAIKey()) {
    try {
      research = await buildAIResearch(city);
    } catch (err) {
      console.error("[agent/profile] AI error, falling back:", err);
      research = buildFallbackResearch(city);
    }
  } else {
    research = buildFallbackResearch(city);
  }

  writeFileSync(cachePath, JSON.stringify(research, null, 2));

  // Return in legacy format for backwards compat
  const brief: AgentBrief = {
    cityId: research.cityId,
    generatedAt: research.generatedAt,
    seasonality: research.seasonalAdvice,
    news: research.summary,
    costEstimates: `${research.costBreakdown.totalBudget} monthly budget (${research.costBreakdown.currency})`,
    recommendations: research.livingConditions.items.slice(0, 2).join(" "),
    score: computeFullScore(city).overall,
  };
  return c.json(brief);
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
    return c.json({ error: "AI service unavailable", message: String(err) }, 503);
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
