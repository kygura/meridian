import { useEffect, useMemo } from "react";
import { useMeridianStore } from "../../store";
import { fetchSeasonality } from "../../lib/seasonalityApi";
import { indexSurfaces, type MetricId, type MetricIndex } from "../../lib/cityMetrics";
import { useMetricSurfaces } from "../map/useFinderData";
import { useJournalToken } from "../../ui";
import { useVisa } from "../../lib/useVisa";
import { cellOf, isoOf, type EntryStatus } from "../../lib/visa/data";
import { useRotation } from "../rotation/useRotation";
import { LOCALES, anchorOf, localeYear, stayWindows, type Locale, type LocaleMonth, type StayWindow } from "../../lib/locales";
import type { PlaceProfile } from "../../lib/rotation";

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
  windows: StayWindow[];
  cap: EntryCap | null;
  profile?: PlaceProfile;
}

/**
 * Everything the Locales page reads, joined per locale: the Comfort Index of each anchor
 * city, the metric surfaces, and while signed in the owner's Personal Windows and passports.
 */
export function useLocaleData() {
  const { unlocked } = useJournalToken();
  const seasonality = useMeridianStore((s) => s.seasonality);
  const mergeSeasonality = useMeridianStore((s) => s.mergeSeasonality);
  const { surfaces, error: surfaceError } = useMetricSurfaces(LOCALE_METRICS);
  const visa = useVisa();
  const rotation = useRotation((s) => s.data);
  const loadRotation = useRotation((s) => s.load);

  useEffect(() => {
    if (unlocked && !rotation) void loadRotation();
  }, [unlocked, rotation, loadRotation]);

  const anchors = useMemo(() => [...new Set(LOCALES.map(anchorOf))], []);
  useEffect(() => {
    const missing = anchors.filter((id) => !(id in seasonality));
    if (!missing.length) return;
    fetchSeasonality(missing)
      .then((r) => mergeSeasonality(r.cities))
      .catch(() => {});
  }, [anchors, seasonality, mergeSeasonality]);

  const metrics: MetricIndex = useMemo(() => indexSurfaces(surfaces as Record<string, never>, LOCALE_METRICS), [surfaces]);
  const profiles = useMemo(() => new Map((unlocked ? rotation?.places ?? [] : []).map((p) => [p.cityId, p])), [rotation, unlocked]);

  const views = useMemo(() => {
    const comfort = (id: string) => seasonality[id];
    return LOCALES.map((locale): LocaleView => {
      const profile = profiles.get(anchorOf(locale));
      const year = localeYear(locale, profile, comfort);
      const cap = visa.data && visa.passports.length ? entryCap(locale, visa.data, visa.passports) : null;
      return { locale, year, windows: stayWindows(locale, year, cap?.days, new Date().getMonth() + 1), cap, profile };
    });
  }, [seasonality, profiles, visa.data, visa.passports]);

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
