// Visa service (ADR 0012): gathers the owner's presence (the journal's past stops, dated trip
// stops, committed Rotation Stays), the places to suggest for buffers and border runs, and
// runs the pure engine (src/lib/visa) with the requirements file and the owner's settings.

import { getCities, getCityById } from "./cities.js";
import { listJourneys } from "./journal.js";
import { listTrips } from "./trips.js";
import { readRotation, stateOf } from "./rotation.js";
import { getAllCitySeasonality } from "./seasonality.js";
import { getVisaData } from "./visaData.js";
import { getVisaSettings } from "./visaStore.js";
import { stayPresence, todayIso } from "../../src/lib/rotation.js";
import { borderRunOptions, checkStays, schengenBuffers, type Place, type StayInput } from "../../src/lib/visa/engine.js";
import { isoOf, sliceFor, type VisaData } from "../../src/lib/visa/data.js";
import { expiryByPassport, passportCodes, type VisaSettings } from "../../src/lib/visa/settings.js";

export interface OwnerStay extends StayInput {
  source: "journal" | "trip" | "rotation";
  /** Trip or journey name, or the rotation stay's place. */
  context: string;
  cityId?: string;
}

/** Everything the owner has been or plans to be, as country and date ranges. */
export async function ownerStays(today = todayIso()): Promise<OwnerStay[]> {
  const out: OwnerStay[] = [];
  let journeys: Awaited<ReturnType<typeof listJourneys>> = [];
  try {
    journeys = await listJourneys();
  } catch {
    journeys = [];
  }
  for (const j of journeys) {
    j.stops.forEach((s, i) => {
      const city = getCityById(s.cityId);
      if (!city || !s.arrive || !s.depart || s.depart < s.arrive) return;
      out.push({ id: `j:${j.id}:${i}`, country: city.country, start: s.arrive, end: s.depart, label: city.name, past: s.depart <= today, source: "journal", context: j.title ?? "Journey", cityId: city.id });
    });
  }
  const { trips } = await listTrips().catch(() => ({ trips: [] as Awaited<ReturnType<typeof listTrips>>["trips"] }));
  for (const t of trips) {
    if (t.origin === "agent") continue;
    t.nodes.forEach((n, i) => {
      const city = getCityById(n.cityId);
      if (!city || !n.arrive || !n.depart || n.depart < n.arrive) return;
      out.push({ id: `t:${t.id}:${i}`, country: city.country, start: n.arrive, end: n.depart, label: city.name, past: n.depart <= today, source: "trip", context: t.name, cityId: city.id });
    });
  }
  const rot = stateOf(await readRotation());
  for (const p of stayPresence(rot.stays)) {
    const st = rot.stays.find((s) => s.id === p.stayId);
    out.push({ id: `r:${p.stayId}`, country: p.country, start: p.start, end: p.end, label: st?.place.name ?? p.country, past: p.end <= today, tentative: p.tentative, source: "rotation", context: "Rotation", cityId: st?.place.cityId });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

let placeCache: Place[] | null = null;

/**
 * Places to suggest: the three largest cities with an airport in each country, with their
 * Comfort Index by month where the seasonality data has it.
 */
export function suggestionPlaces(): Place[] {
  if (placeCache) return placeCache;
  const comfort = getAllCitySeasonality();
  const byCountry = new Map<string, ReturnType<typeof getCities>>();
  for (const c of getCities()) {
    if (!c.iata) continue;
    const list = byCountry.get(c.country) ?? [];
    list.push(c);
    byCountry.set(c.country, list);
  }
  const out: Place[] = [];
  for (const list of byCountry.values()) {
    for (const c of list.sort((a, b) => b.population - a.population).slice(0, 3)) {
      const m = comfort[c.id];
      out.push({ cityId: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng, iata: c.iata, comfort: m ? m.map((x) => (typeof x?.score === "number" ? Math.round(x.score) : null)) : null });
    }
  }
  placeCache = out;
  return out;
}

export interface VisaContext {
  data: VisaData;
  settings: VisaSettings;
  passports: string[];
}

export async function visaContext(): Promise<VisaContext | { error: string }> {
  const data = getVisaData();
  if (!data) return { error: "The visa data file is missing on this server (data/visa-requirements.json). Run npm run build:visa." };
  const settings = await getVisaSettings();
  return { data, settings, passports: passportCodes(settings) };
}

/** The slice of the data the browser needs: the owner's passports' rows, names, validity, sources. */
export function browserData(ctx: VisaContext): VisaData {
  return sliceFor(ctx.data, ctx.passports);
}

/** checkStays with the owner's settings; `passports` overrides them (the agent may ask about another). */
export function checkForOwner(ctx: VisaContext, stays: StayInput[], opts: { today?: string; passports?: string[] } = {}) {
  const passports = opts.passports?.length ? opts.passports : ctx.passports;
  return checkStays(ctx.data, passports, stays, { today: opts.today, expiry: expiryByPassport(ctx.settings) });
}

export function buffersFor(ctx: VisaContext, from: { lat: number; lng: number }, start: string, nights: number, passports?: string[]) {
  return schengenBuffers(ctx.data, passports?.length ? passports : ctx.passports, from, start, nights, suggestionPlaces());
}

export function borderRunsFor(ctx: VisaContext, from: { country: string; lat: number; lng: number; date: string }, passports?: string[]) {
  return borderRunOptions(ctx.data, passports?.length ? passports : ctx.passports, from, suggestionPlaces());
}

/** A city id to the place the engine needs. */
export function placeOfCity(cityId: string): { country: string; lat: number; lng: number; name: string } | null {
  const c = getCityById(cityId);
  return c ? { country: c.country, lat: c.lat, lng: c.lng, name: c.name } : null;
}

export { isoOf };
