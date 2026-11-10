// City research without invented numbers (ADR 0013). The keyless research path used to print
// made-up rent and speed ranges picked by a hashed score; it now states the measured figures
// from server/lib/placeData.ts with their source, and says "No data" where there are none.
// The Claude path gets the same figures as given facts.

import type { City, CityResearch, NearbyDestination } from "../../../src/types.js";
import { placeDataInfo, placeFacts, type Fact, type PlaceFacts } from "../placeData.js";
import { busiestMonths } from "./tools.js";

export const NO_DATA = "No data";

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;
const GRAIN = { city: "measured for this city", region: "regional figure", country: "country figure" } as const;

function sourced(f: Fact, text: string): string {
  const { sources } = placeDataInfo();
  const name = sources[f.source]?.name ?? f.source;
  return `${text} (${f.estimate ? "estimate, " : ""}${GRAIN[f.granularity]}; ${name}${f.year ? `, ${f.year}` : ""})`;
}

/** The measured facts as plain sentences, one per line; gaps are stated. Used in the Claude prompt and the keyless text. */
export function factSentences(city: City, f: PlaceFacts = placeFacts(city)): string[] {
  const { sources } = placeDataInfo();
  const out: string[] = [];
  const c = f.cost;
  out.push(c.monthlyEur ? sourced(c.monthlyEur, `Monthly cost for one person, housing included: about ${eur(c.monthlyEur.value)}`) : `Monthly cost: ${NO_DATA}`);
  if (c.rent1br) out.push(sourced(c.rent1br, `Average rent, 1-bedroom flat: ${eur(c.rent1br.value)} a month`));
  else if (c.rentReference) out.push(sourced(c.rentReference, `Rent in ${city.name}: ${NO_DATA}. In ${c.rentReference.place} a 1-bedroom flat averages ${eur(c.rentReference.value)} a month`));
  else out.push(`Rent: ${NO_DATA}`);
  const net = f.internet;
  const netSrc = sources.internet?.name ?? "Ookla Open Data";
  out.push(net.fixed ? `Fixed internet: ${net.fixed.downMbps} Mbps down, ${net.fixed.upMbps} up (measured within ${net.fixed.radiusKm} km; ${netSrc})` : `Fixed internet speed: ${NO_DATA}`);
  out.push(net.mobile ? `Mobile internet: ${net.mobile.downMbps} Mbps down, ${net.mobile.upMbps} up (measured within ${net.mobile.radiusKm} km; ${netSrc})` : `Mobile internet speed: ${NO_DATA}`);
  const h = f.health;
  out.push(h.uhc ? sourced(h.uhc, `Healthcare coverage: ${h.uhc.value} of 100`) : `Healthcare coverage: ${NO_DATA}`);
  if (h.physicians) out.push(sourced(h.physicians, `Physicians: ${h.physicians.value} per 1,000 people`));
  if (h.beds) out.push(sourced(h.beds, `Hospital beds: ${h.beds.value} per 1,000 people`));
  const s = f.stability;
  out.push(s.estimate ? sourced(s.estimate, `Political stability: ${s.estimate.value} on a scale from about -2.5 to 2.5`) : `Political stability: ${NO_DATA}`);
  if (s.homicides) out.push(`Homicides: ${s.homicides.value} per 100,000 people a year (country figure; World Bank, UNODC)`);
  const cr = f.crowds;
  out.push(cr.arrivalsPerResident ? sourced(cr.arrivalsPerResident, `Visitors from abroad: ${cr.arrivalsPerResident.value} per resident a year`) : `Visitor numbers: ${NO_DATA}`);
  if (cr.months) out.push(`Busiest months: ${busiestMonths(cr.months.index)} (${GRAIN[cr.months.granularity]}; ${sources[cr.months.source]?.name ?? "Eurostat"})`);
  return out;
}

/** Why a nearby city is worth a look, from what is measured about it; null when nothing stands out. */
export function nearbyReason(city: City): string | null {
  const f = placeFacts(city);
  if (f.cost.monthlyEur && f.scores.cost !== null && f.scores.cost >= 65) return `About ${eur(f.cost.monthlyEur.value)} a month (estimate)`;
  if (f.internet.fixed && f.internet.fixed.downMbps >= 150) return `Fast internet: ${f.internet.fixed.downMbps} Mbps`;
  if (f.scores.stability !== null && f.scores.stability >= 75) return "Safe and stable by country figures";
  if (f.scores.health !== null && f.scores.health >= 80) return "Strong healthcare coverage";
  return null;
}

/** Research built only from measured facts. Sections with nothing measured say so. */
export function factResearch(city: City, nearby: NearbyDestination[]): CityResearch {
  const f = placeFacts(city);
  const { anchor } = placeDataInfo();
  const c = f.cost;
  const net = f.internet;
  const population = city.population > 0 ? `Population ${city.population.toLocaleString("en-US")}. ` : "";
  const costLine = c.monthlyEur
    ? `Living costs come to about ${eur(c.monthlyEur.value)} a month for one person (an estimate from the country's price level).`
    : "There is no cost data for this city.";
  const netLine = net.fixed ? `Fixed internet averages ${net.fixed.downMbps} Mbps.` : net.mobile ? `Mobile internet averages ${net.mobile.downMbps} Mbps; no fixed-line data.` : "There is no internet speed data for this city.";

  return {
    cityId: city.id,
    generatedAt: new Date().toISOString(),
    summary: `${city.name}, ${city.country}. ${population}${costLine} ${netLine} This summary lists measured figures only; set an Anthropic key for a written briefing.`,
    livingConditions: { title: "Measured figures", items: factSentences(city, f) },
    costBreakdown: {
      rent: c.rent1br
        ? `${eur(c.rent1br.value)}/mo average, 1-bedroom flat (Eurostat, ${c.rent1br.year})`
        : c.rentReference
          ? `${NO_DATA} for ${city.name}. ${c.rentReference.place}: ${eur(c.rentReference.value)}/mo (Eurostat, ${c.rentReference.year})`
          : NO_DATA,
      food: NO_DATA,
      transport: NO_DATA,
      coworking: NO_DATA,
      healthcare: NO_DATA,
      totalBudget: c.monthlyEur
        ? `About ${eur(c.monthlyEur.value)}/mo for one person, housing included (estimate${anchor ? `: ${anchor.place} spending of ${eur(anchor.monthlyEur)}/mo repriced at local prices` : ""}; ${c.monthlyEur.granularity} figure)`
        : NO_DATA,
      currency: city.currency || NO_DATA,
    },
    visa: {
      touristVisa: `${NO_DATA}. Check ${city.country}'s official entry requirements for your passport.`,
      visaOnArrival: NO_DATA,
      eVisa: NO_DATA,
      digitalNomadVisa: NO_DATA,
      commonPassportNotes: NO_DATA,
    },
    connectivity: {
      avgDownloadMbps: net.fixed ? `${net.fixed.downMbps} Mbps down, ${net.fixed.upMbps} up, fixed (Ookla, ${net.period ?? "latest quarter"}; ${net.fixed.tests.toLocaleString("en-US")} tests)` : NO_DATA,
      mobileCoverage: net.mobile ? `${net.mobile.downMbps} Mbps down on mobile (Ookla, ${net.period ?? "latest quarter"})` : NO_DATA,
      coworkingSpaces: NO_DATA,
      cafeWifi: NO_DATA,
    },
    safetyNotes: [
      f.stability.estimate
        ? `Political stability ${f.stability.estimate.value} on the World Bank scale of about -2.5 to 2.5 (country figure, ${f.stability.estimate.year}).`
        : `Political stability: ${NO_DATA}.`,
      f.stability.homicides ? `${f.stability.homicides.value} homicides per 100,000 people a year (country figure).` : `Homicide rate: ${NO_DATA}.`,
      "Check your government's travel advice before you go.",
    ],
    seasonalAdvice: f.crowds.months
      ? `Busiest months for visitors: ${busiestMonths(f.crowds.months.index)} (${f.crowds.months.granularity} figure, Eurostat nights in tourist accommodation). See When to go for the climate by month.`
      : "No visitor data by month for this city. See When to go for the climate by month.",
    nearbyDestinations: nearby,
  };
}
