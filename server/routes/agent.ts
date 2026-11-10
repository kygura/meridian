import { Hono } from "hono";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getCityById, getCities } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { ensureDataDir } from "../lib/paths.js";
import { getFlightEstimate } from "../lib/flightSearch.js";
import {
  searchPlaces,
  searchPlacesParams,
  getPlaceImages,
  getPlaceImagesParams,
  getSeasonality,
  getSeasonalityParams,
  getFlightEstimate as getFlightEstimateTool,
  getFlightEstimateParams,
  getPlaceFacts,
  getPlaceFactsParams,
  REGION_COUNTRIES,
} from "../lib/agent/tools.js";
import { factResearch, factSentences, nearbyReason } from "../lib/agent/researchFacts.js";
import {
  createJournalTools,
  searchJournalParams,
  getFingerprintParams,
  findSimilarWindowsParams,
  draftJourneyParams,
  parseJournalIntent,
} from "../lib/agent/journal-tools.js";
import { ownerIdentity } from "../middleware/auth.js";
import { CLAUDE_MODELS, DEFAULT_MODEL, completeText, hasAnthropicKey, parseJsonReply, resolveModel, runClaudeChat, type AgentTool } from "../lib/agent/claude.js";
import type { TickerItem, AgentBrief, City, CityResearch, NearbyDestination, TripOption, TripNode, TripEstimate } from "../../src/types.js";

const agent = new Hono();

const CACHE_DIR = ensureDataDir("cache");
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours for research (more current)
const BRIEF_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for simple briefs

// Claude (Anthropic) powers chat, research and the ticker; without ANTHROPIC_API_KEY
// every route runs its deterministic mock path.
const hasAIKey = hasAnthropicKey;

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
      // Blend proximity with the score; a city with too little data for a score ranks on proximity alone.
      const aRank = (a.score.overall ?? 0) * 0.6 + (1 - a.dist / 4000) * 40;
      const bRank = (b.score.overall ?? 0) * 0.6 + (1 - b.dist / 4000) * 40;
      return bRank - aRank;
    })
    .slice(0, maxCount);

  return all.map((e) => ({
    cityId: e.city.id,
    name: e.city.name,
    country: e.city.country,
    iata: e.city.iata,
    lat: e.city.lat,
    lng: e.city.lng,
    distance: formatDistance(e.dist),
    // The reason is read from measured figures (ADR 0013); with none that stand out, it is the distance.
    reason: nearbyReason(e.city) ?? (e.score.overall !== null ? `Score ${e.score.overall} of 100` : `${formatDistance(e.dist)} away`),
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
  // Measured figures only, each with its source; "No data" where there are none (ADR 0013).
  return factResearch(city, findNearbyDestinations(city));
}

// ── AI-powered research ──────────────────────────────────────────────

async function buildAIResearch(city: City): Promise<CityResearch> {
  const score = computeFullScore(city);
  const na = (v: number | null) => (v === null ? "n/a" : String(v));
  const nearby = findNearbyDestinations(city);
  const nearbyNames = nearby.slice(0, 4).map((n) => `${n.name}, ${n.country}`).join("; ");

  const prompt = `Research the city of ${city.name}, ${city.country} for a digital nomad / remote worker audience. Today's date: ${new Date().toISOString().split("T")[0]}.

City data:
- Population: ${city.population.toLocaleString()}
- Coordinates: ${city.lat}, ${city.lng}
- Meridian Score: ${score.overall === null ? "not enough data" : `${score.overall}/100`} (0-100 each, "n/a" = no data; affordability: ${na(score.economics)}, quality of life: ${na(score.quality)}, climate: ${na(score.climate)}, safety: ${na(score.stability)}, internet: ${na(score.nomadInfra)}, healthcare: ${na(score.health)})
- Nearby destinations worth considering: ${nearbyNames}

Measured figures (use these as given, with their source; do not replace them with your own numbers):
${factSentences(city).map((l) => `- ${l}`).join("\n")}

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

Be specific to ${city.name}, ${city.country}. Do not give generic advice. Where a measured figure is given above, quote it and name its source. Any other number is your own estimate: write "roughly" before it and "(estimate)" after it. Where you don't know, write "No data" rather than guessing.`;

  const text = await completeText({
    system: "You are Meridian, a nomadic intelligence analyst. You provide detailed, specific, and actionable intelligence about cities for digital nomads and remote workers. Always return valid JSON with no markdown formatting.",
    prompt,
  });

  try {
    const parsed = parseJsonReply<CityResearch & Record<string, unknown>>(text);
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

// ── Mock chat (ADR 0003: keyless path calls the SAME tool-core functions
// the real Claude loop wraps, and emits the same AI SDK v4 data-stream
// tool-call/tool-result parts so useChat's message.toolInvocations shape is
// identical whether ANTHROPIC_API_KEY is set or not) ──────────────────────

function parseMockIntent(lastUserText: string): {
  region?: string;
  regionLabel: string;
  cheap: boolean;
  safe: boolean;
  mentionedCity?: City;
} {
  const last = lastUserText.toLowerCase();
  let region: string | undefined;
  let regionLabel = "globally";
  for (const key of Object.keys(REGION_COUNTRIES)) {
    if (last.includes(key)) {
      region = key;
      regionLabel = key === "equator" ? "near the equator" : `in ${key}`;
      break;
    }
  }
  const cheap = /cheap|afford|budget|cost/.test(last);
  const safe = /safe|secure|stab|risk/.test(last);

  // City-name detection: if the user names a city, target it directly for
  // images/seasonality. Word-boundary match, highest population wins ties.
  let mentionedCity: City | undefined;
  for (const c of getCities()) {
    const name = c.name.toLowerCase();
    if (name.length < 4) continue;
    if (!last.includes(name)) continue;
    const re = new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
    if (!re.test(last)) continue;
    if (
      !mentionedCity ||
      name.length > mentionedCity.name.length ||
      (name.length === mentionedCity.name.length && c.population > mentionedCity.population)
    ) {
      mentionedCity = c;
    }
  }

  return { region, regionLabel, cheap, safe, mentionedCity };
}

/** Plain words for fingerprint dimensions, so replies never show internal field names (crowdProxy → crowds). */
const DIM_WORDS: Record<string, string> = {
  month: "season",
  comfort: "comfort",
  tempC: "temperature",
  precipMm: "rainfall",
  dailySpendEur: "daily spend",
  flightCostEurPer1000km: "flight cost",
  crowdProxy: "crowds",
};

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Mock path for "somewhere like <past trip> but …": search_journal → find_similar_windows → Open Places. */
async function streamMockJournalChat(
  intent: NonNullable<ReturnType<typeof parseJournalIntent>>,
  unlocked: boolean
): Promise<Response> {
  const { createDataStreamResponse, formatDataStreamPart } = await import("ai");
  const tools = createJournalTools({ unlocked });
  return createDataStreamResponse({
    execute: async (dataStream) => {
      let callIndex = 0;
      const call = async <A, R>(toolName: string, args: A, fn: (a: A) => Promise<R>): Promise<R> => {
        const toolCallId = `mock-call-${++callIndex}`;
        dataStream.write(formatDataStreamPart("tool_call", { toolCallId, toolName, args }));
        const result = await fn(args);
        dataStream.write(formatDataStreamPart("tool_result", { toolCallId, result: result as never }));
        return result;
      };

      const searchArgs = searchJournalParams.parse({ text: intent.cityName, month: intent.pastMonth });
      const found = await call("search_journal", searchArgs, tools.searchJournal);

      let text: string;
      if ("error" in found) {
        text = found.error === "journal_locked"
          ? "Your journal is locked, so I can't look up the trip you mean. Unlock it in Settings with your Meridian token, then ask again."
          : "I couldn't read your journal just now. Try again in a moment.";
      } else if (found.journeys.length === 0) {
        text = `I couldn't find a journey in your journal matching ${intent.cityName ?? "that"}${intent.pastMonth ? ` in ${MONTH_LONG[intent.pastMonth - 1]}` : ""}. ` +
          "Log it as a past trip (or import it) and I can find places like it.";
      } else {
        const template = found.journeys[0]!;
        const simArgs = findSimilarWindowsParams.parse({
          journeyId: template.id,
          bend: intent.bend,
          ...(intent.months ? { months: intent.months } : {}),
          limit: 5,
        });
        const sim = await call("find_similar_windows", simArgs, tools.findSimilarWindows);
        if ("error" in sim) {
          text = sim.error === "template_not_fingerprinted"
            ? `"${template.title}" is still being analysed (its weather may still be loading). Try again in a moment.`
            : "I couldn't search for similar places just now. Try again in a moment.";
        } else {
          const bends = [
            intent.bend.tempC ? `${intent.bend.tempC > 0 ? "warmer" : "cooler"} (${intent.bend.tempC > 0 ? "+" : ""}${intent.bend.tempC}°C)` : "",
            intent.bend.spendPct ? `${intent.bend.spendPct < 0 ? "cheaper" : "pricier"} (${intent.bend.spendPct}% spend)` : "",
            intent.bend.crowd ? `${intent.bend.crowd < 0 ? "quieter" : "busier"}` : "",
          ].filter(Boolean);
          const lines = sim.places.map((p) => {
            const top = [...(p.replayMatch?.dims ?? [])].sort((a, b) => b.contribution - a.contribution)[0];
            return `• ${p.name}, ${p.country} — ${p.summaryLine}${top ? ` (closest on ${DIM_WORDS[top.name] ?? "overall feel"})` : ""}`;
          });
          text =
            `Based on "${template.title}" (${template.startDate}), here are the closest matches${bends.length ? `, bent ${bends.join(" and ")}` : ""}` +
            `${intent.months ? ` in ${intent.months.map((m) => MONTH_LONG[m - 1]).join("/")}` : ""}:\n\n` +
            (lines.length ? lines.join("\n") : "Nothing matched. Try more months or fewer changes.") +
            `\n\nCompared against ${sim.universeSize} cities with climate data. Flight prices marked mock are estimates and don't affect the match.`;
        }
      }
      for (const tok of text.split(/(\s+)/)) {
        if (!tok) continue;
        dataStream.write(formatDataStreamPart("text", tok));
        await new Promise((r) => setTimeout(r, 14));
      }
    },
  });
}

async function streamMockChatWithTools(messages: Array<{ role: string; content: string }>, unlocked = false): Promise<Response> {
  const { createDataStreamResponse, formatDataStreamPart } = await import("ai");
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const { region, regionLabel, cheap, safe, mentionedCity } = parseMockIntent(lastUserText);

  const journalIntent = parseJournalIntent(lastUserText, mentionedCity?.name);
  if (journalIntent) return streamMockJournalChat(journalIntent, unlocked);

  return createDataStreamResponse({
    execute: async (dataStream) => {
      let callIndex = 0;
      const nextId = () => `mock-call-${++callIndex}`;

      // 1. search_places — same function the real tool loop calls.
      const searchArgs = searchPlacesParams.parse({
        query: mentionedCity?.name,
        region,
        budgetTier: cheap ? "budget" : undefined,
        minScore: !cheap && safe ? 60 : undefined,
        limit: 4,
      });
      const searchCallId = nextId();
      dataStream.write(
        formatDataStreamPart("tool_call", { toolCallId: searchCallId, toolName: "search_places", args: searchArgs })
      );
      const places = await searchPlaces(searchArgs);
      dataStream.write(formatDataStreamPart("tool_result", { toolCallId: searchCallId, result: places }));

      // Target for enrichment: the explicitly-named city when there is one
      // (deterministic even if score-ranking buries it), otherwise the
      // top-ranked search result.
      const top: { cityId: string; name: string } | undefined = mentionedCity
        ? { cityId: mentionedCity.id, name: mentionedCity.name }
        : places[0];

      // 2. get_place_images for the top result.
      let topImages: Awaited<ReturnType<typeof getPlaceImages>> = [];
      if (top) {
        const imgArgs = getPlaceImagesParams.parse({ cityId: top.cityId, limit: 2 });
        const imgCallId = nextId();
        dataStream.write(
          formatDataStreamPart("tool_call", { toolCallId: imgCallId, toolName: "get_place_images", args: imgArgs })
        );
        topImages = await getPlaceImages(imgArgs);
        dataStream.write(formatDataStreamPart("tool_result", { toolCallId: imgCallId, result: topImages }));
      }

      // 3. get_seasonality for the top result.
      let seasonality: Awaited<ReturnType<typeof getSeasonality>> = { available: false };
      if (top) {
        const seasonArgs = getSeasonalityParams.parse({ cityId: top.cityId });
        const seasonCallId = nextId();
        dataStream.write(
          formatDataStreamPart("tool_call", { toolCallId: seasonCallId, toolName: "get_seasonality", args: seasonArgs })
        );
        seasonality = await getSeasonality(seasonArgs);
        dataStream.write(formatDataStreamPart("tool_result", { toolCallId: seasonCallId, result: seasonality }));
      }

      // 3b. get_place_facts for the top result: measured figures with their sources, gaps stated.
      let factLines: string[] = [];
      if (top) {
        const factArgs = getPlaceFactsParams.parse({ cityId: top.cityId });
        const factCallId = nextId();
        dataStream.write(formatDataStreamPart("tool_call", { toolCallId: factCallId, toolName: "get_place_facts", args: factArgs }));
        const facts = await getPlaceFacts(factArgs);
        dataStream.write(formatDataStreamPart("tool_result", { toolCallId: factCallId, result: facts }));
        const wanted = ["Monthly cost for one person", "Rent, 1-bedroom flat", "Fixed internet", "Healthcare coverage"];
        factLines = (facts.facts ?? [])
          .filter((l) => wanted.includes(l.label))
          .map((l) =>
            l.source
              ? `• ${l.label}: ${l.value} (${l.estimate ? "estimate, " : ""}${l.granularity} figure; ${l.source})`
              : `• ${l.label}: no data`
          );
      }

      // 4. Streamed text summary, built from the real tool results above.
      const angle = cheap
        ? "budget places, best score first"
        : safe
          ? "best overall, with a safety floor"
          : "best overall first";
      const lines = places.map((p) => `• ${p.name}, ${p.country}: ${p.summaryLine}`);
      const imageNote = top && topImages.length ? ` Found ${topImages.length === 1 ? "a photo" : `${topImages.length} photos`} of ${top.name}.` : "";
      const seasonNote = top && seasonality.available ? ` Best months to visit ${top.name} are available.` : "";

      const text =
        `Here are the best places ${regionLabel} right now, ${angle}:\n\n` +
        (lines.length ? lines.join("\n") : "Nothing matched that. Try a broader region.") +
        (top && factLines.length ? `\n\n${top.name} in figures:\n${factLines.join("\n")}` : "") +
        `\n\n${(imageNote + seasonNote).trim()}`.trimEnd() +
        `\n\nTap a city below to open it. ` +
        `(Live AI replies are off on this server, so these picks come from Meridian's own scoring.)`;

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

  if (hasAIKey()) {
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
  if (hasAIKey()) {
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
    score: computeFullScore(city).overall ?? undefined,
  };
  return c.json(brief);
});

const CHAT_SYSTEM = `You are Meridian, a travel research analyst. Help users discover cities for remote work and travel by
actively using your tools: search_places to find and rank candidate cities, get_place_facts for a city's measured
cost, rent, internet, healthcare, stability and visitor figures, get_place_images to pull a
representative photo, get_seasonality to check the best months to visit, and get_flight_estimate to price a route.
Call the relevant tools before making specific claims about scores, images, timing, or prices — don't guess numbers
you could look up. When you quote a figure from get_place_facts, say where it comes from and whether it is a city, regional
or country figure, and say when a cost is an estimate. When a figure comes back as "No data", say there is no data: never
fill the gap with a number of your own. Be concise, specific, and actionable.
For the user's own travel history use the journal tools: search_journal to find a past journey, get_fingerprint for the
conditions it had, find_similar_windows to rank other destination/month windows like it (bend with tempC/spendPct/crowd),
and draft_journey to propose a journey for the user to review in the inbox (you cannot confirm it). If a journal tool
returns journal_locked, tell the user to sign in under Settings.
Write for a traveller in plain words: never mention tool names, field names, ids or error codes. Say "crowds" not
"crowdProxy", "temperature" not "tempC", "rainfall" not "precipMm", "daily spend" not "dailySpendEur", "flight cost" not
"flightCostEurPer1000km", "best months" not "seasonality", and "similar places" not "windows". Mention city names in full
(e.g. "Lisbon") so the app can link them.`;

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
    /** Claude model id from GET /api/agent/models; unknown ids fall back to the default. */
    model: z.string().optional(),
  });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  // Journal tools run only for the signed-in owner (session cookie or Bearer token).
  const unlocked = !!(await ownerIdentity(c));
  if (!hasAIKey()) {
    return streamMockChatWithTools(parsed.data.messages, unlocked);
  }
  const journal = createJournalTools({ unlocked });
  const model = resolveModel(parsed.data.model);
  const tools: Record<string, AgentTool> = {
    search_places: {
      description:
        "Search and rank cities/places by name, country, region, budget tier, or minimum Meridian score. Returns up to 8 ranked results.",
      parameters: searchPlacesParams,
      execute: searchPlaces as AgentTool["execute"],
    },
    get_place_images: {
      description:
        "Get up to 4 representative photos for a city (by cityId) or a free-text place title, sourced from Wikipedia/Wikimedia Commons with attribution.",
      parameters: getPlaceImagesParams,
      execute: getPlaceImages as AgentTool["execute"],
    },
    get_place_facts: {
      description:
        "Get the measured figures for a city (by cityId): monthly cost, rent, internet speed, healthcare, stability, visitors and busiest months. Each has its source, year and granularity (city, region or country); figures with no data come back as 'No data'.",
      parameters: getPlaceFactsParams,
      execute: getPlaceFacts as AgentTool["execute"],
    },
    get_seasonality: {
      description: "Get monthly climate/comfort seasonality for a city, when available.",
      parameters: getSeasonalityParams,
      execute: getSeasonality as AgentTool["execute"],
    },
    get_flight_estimate: {
      description: "Estimate flight price between two IATA airport codes, optionally for a given departure date.",
      parameters: getFlightEstimateParams,
      execute: getFlightEstimateTool as AgentTool["execute"],
    },
    search_journal: {
      description: "Search the user's past journeys by text, cityId, country, year, month, tags or minimum rating. Returns summaries with a fingerprint brief.",
      parameters: searchJournalParams,
      execute: journal.searchJournal as AgentTool["execute"],
    },
    get_fingerprint: {
      description: "Get the conditions (weather, spend, crowd proxy) a past journey, or one of its stops, actually had.",
      parameters: getFingerprintParams,
      execute: journal.getFingerprint as AgentTool["execute"],
    },
    find_similar_windows: {
      description:
        "Rank destination x month windows similar to a past journey (journeyId). bend: tempC -10..10, spendPct -50..50, crowd -50..50, monthShift. months restricts target months (1-12). Results also come as Open Places with a match breakdown.",
      parameters: findSimilarWindowsParams,
      execute: journal.findSimilarWindows as AgentTool["execute"],
    },
    draft_journey: {
      description: "Draft a journey (stops with cityId or cityHint, dates, optional segments) into the user's review inbox. Cannot confirm it.",
      parameters: draftJourneyParams,
      execute: journal.draftJourney as AgentTool["execute"],
    },
  };

  const { createDataStreamResponse, formatDataStreamPart } = await import("ai");
  return createDataStreamResponse({
    execute: (dataStream) =>
      runClaudeChat({
        model,
        system: CHAT_SYSTEM,
        messages: parsed.data.messages,
        tools,
        write: (part) => dataStream.write(part as never),
        format: formatDataStreamPart,
      }),
    onError: (err) => {
      console.error("[agent/chat] Claude error:", err);
      return "The assistant is unavailable right now. Try again in a moment.";
    },
  });
});

/** GET /api/agent/models - the Claude models the Ask panel can switch between. */
agent.get("/models", (c) => {
  return c.json({ models: CLAUDE_MODELS, default: DEFAULT_MODEL, available: hasAIKey() });
});

/** POST /api/agent/ticker - Generate ticker items */
agent.post("/ticker", async (c) => {
  if (!hasAIKey()) {
    return c.json(MOCK_TICKER);
  }

  try {
    const text = await completeText({
      system: `You are a global events monitor. Return a JSON array of 5-8 ticker items about current global events relevant to travelers and digital nomads.
Each item must have: glyph (one of: "alert", "hazard", "info", "good"), location (country or city name, UPPERCASE), text (one sentence), time (relative time like "12m", "1h", "3h").
Return ONLY the JSON array, no markdown or explanation.`,
      prompt: `Generate current global event ticker items for a nomad intelligence dashboard. Focus on: conflicts, natural disasters, visa changes, currency shifts, infrastructure events, and positive developments. Today is ${new Date().toISOString().split("T")[0]}.`,
    });

    try {
      const items = parseJsonReply<TickerItem[]>(text);
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
