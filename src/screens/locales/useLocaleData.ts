import { useEffect, useMemo, useState } from "react";
import { useMeridianStore } from "../../store";
import { apiUrl } from "../../lib/api";
import { fetchSeasonality, fetchWeekly, type SeasonWeek } from "../../lib/seasonalityApi";
import { indexSurfaces, type MetricId, type MetricIndex } from "../../lib/cityMetrics";
import { useMetricSurfaces } from "../map/useFinderData";
import { useJournalToken } from "../../ui";
import { useVisa } from "../../lib/useVisa";
import { cellOf, isoOf, type EntryStatus } from "../../lib/visa/data";
import { useRotation } from "../rotation/useRotation";
import {
  LOCALES,
  anchorOf,
  crowdsFromEvents,
  hazardHits,
  localeYear,
  stayWindows,
  weekLevels,
  type HazardHit,
  type Locale,
  type LocaleMonth,
  type StayWindow,
} from "../../lib/locales";
import type { FitLevel, PlaceProfile } from "../../lib/rotation";
import type { MapAnomaly, MeridianEvent } from "../../types";

export const LOCALE_METRICS: MetricId[] = ["quality", "stability", "health", "cost", "connectivity"];

/** What the owner's passports allow in a locale's country, best passport first. */
export interface EntryCap {
  /** Days per stay the dataset gives; null for no limit (home, free movement) or unknown. */
  days: number | null;
  status: EntryStatus;
  passport: string;
}

const STATUS_ORDER: EntryStatus[] = ["home", "free-movement", "visa-free", "visa-on-arrival", "eta", "e-visa", "visa-required", "no-admission", "unknown"];

export interface LocaleView {
  locale: Locale;
  year: LocaleMonth[];
  /** Week-of-year fits from weekly normals, for drawing, or null where the city has none yet. */
  weeks: FitLevel[] | null;
  windows: StayWindow[];
  cap: EntryCap | null;
  profile?: PlaceProfile;
  hazards: HazardHit[];
  /** Festivals, highlights and sky events from Meridian's live events (not tourism or climate seasons). */
  events: MeridianEvent[];
}

// Module caches: events and anomalies change daily at most.
let eventsCache: MeridianEvent[] | null = null;
let anomaliesCache: MapAnomaly[] | null = null;
let weeklyCache: Record<string, SeasonWeek[] | null> | null = null;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json() as Promise<T>;
}

/**
 * Everything the Locales page reads, joined per locale, all from Meridian's own data: the
 * anchor city's Comfort Index (monthly, and weekly where the normals exist), seasonal hazards
 * in reach, measured tourism seasons, live events and the metric surfaces; while signed in,
 * the owner's rotation windows and passports.
 */
export function useLocaleData() {
  const { unlocked } = useJournalToken();
  const cities = useMeridianStore((s) => s.cities);
  const seasonality = useMeridianStore((s) => s.seasonality);
  const mergeSeasonality = useMeridianStore((s) => s.mergeSeasonality);
  const { surfaces, error: surfaceError } = useMetricSurfaces(LOCALE_METRICS);
  const visa = useVisa();
  const rotation = useRotation((s) => s.data);
  const loadRotation = useRotation((s) => s.load);
  const [events, setEvents] = useState<MeridianEvent[] | null>(eventsCache);
  const [anomalies, setAnomalies] = useState<MapAnomaly[] | null>(anomaliesCache);
  const [weekly, setWeekly] = useState<Record<string, SeasonWeek[] | null> | null>(weeklyCache);

  useEffect(() => {
    if (unlocked && !rotation) void loadRotation();
  }, [unlocked, rotation, loadRotation]);

  const anchors = useMemo(() => [...new Set(LOCALES.map(anchorOf))], []);
  const allIds = useMemo(() => [...new Set(LOCALES.flatMap((l) => l.cityIds))], []);

  useEffect(() => {
    const missing = anchors.filter((id) => !(id in seasonality));
    if (!missing.length) return;
    fetchSeasonality(missing)
      .then((r) => mergeSeasonality(r.cities))
      .catch(() => {});
  }, [anchors, seasonality, mergeSeasonality]);

  useEffect(() => {
    if (!weeklyCache)
      fetchWeekly(anchors)
        .then((w) => setWeekly((weeklyCache = w)))
        .catch(() => setWeekly({}));
    if (!anomaliesCache)
      getJson<{ items?: MapAnomaly[] }>("/api/overlays/anomalies")
        .then((b) => setAnomalies((anomaliesCache = Array.isArray(b.items) ? b.items : [])))
        .catch(() => setAnomalies([]));
    if (!eventsCache)
      getJson<{ events?: MeridianEvent[] }>(`/api/overlays/events?cityIds=${allIds.map(encodeURIComponent).join(",")}`)
        .then((b) => setEvents((eventsCache = Array.isArray(b.events) ? b.events : [])))
        .catch(() => setEvents([]));
  }, [anchors, allIds]);

  const metrics: MetricIndex = useMemo(() => indexSurfaces(surfaces as Record<string, never>, LOCALE_METRICS), [surfaces]);
  const profiles = useMemo(() => new Map((unlocked ? rotation?.places ?? [] : []).map((p) => [p.cityId, p])), [rotation, unlocked]);
  const cityById = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);

  const views = useMemo(() => {
    const comfort = (id: string) => seasonality[id];
    const fromMonth = new Date().getMonth() + 1;
    return LOCALES.map((locale): LocaleView => {
      const id = anchorOf(locale);
      const anchor = cityById.get(id);
      const profile = profiles.get(id);
      const hazards = anchor && anomalies ? hazardHits(anchor.lat, anchor.lng, anomalies) : [];
      const mine = (events ?? []).filter((e) => e.cityIds.some((c) => locale.cityIds.includes(c)));
      // Tourism seasons are the anchor city's own; another city's peak says nothing about it.
      const crowds = crowdsFromEvents(mine.filter((e) => e.cityIds.includes(id)));
      const year = localeYear(locale, { profile, comfort, hazards, crowds });
      const cap = visa.data && visa.passports.length ? entryCap(locale, visa.data, visa.passports) : null;
      return {
        locale,
        year,
        // A rotation window overrides months, so weekly comfort would contradict it: draw months then.
        weeks: profile?.windows.length ? null : weekLevels(weekly?.[id]),
        windows: stayWindows(locale, year, cap?.days, fromMonth),
        cap,
        profile,
        hazards,
        events: mine.filter((e) => e.kind !== "season" && e.recurring),
      };
    });
  }, [seasonality, profiles, visa.data, visa.passports, anomalies, events, weekly, cityById]);

  const comfortLoaded = anchors.some((id) => seasonality[id]);
  return { views, metrics, surfaceError, unlocked, comfortLoaded, signedInVisa: !!visa.data && visa.passports.length > 0 };
}

function entryCap(locale: Locale, data: NonNullable<ReturnType<typeof useVisa>["data"]>, passports: string[]): EntryCap | null {
  const iso = isoOf(data, locale.country);
  if (!iso) return null;
  const cells = passports.map((p) => ({ passport: p, ...cellOf(data, p, iso) }));
  cells.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (b.days ?? 0) - (a.days ?? 0));
  const best = cells[0];
  if (!best) return null;
  const free = best.status === "home" || best.status === "free-movement";
  return { days: free ? null : best.days, status: best.status, passport: best.passport };
}
