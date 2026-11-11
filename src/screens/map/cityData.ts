import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { fetchCitySeasonality, SeasonalityUnavailableError, type SeasonMonth } from "../../lib/seasonalityApi";
import { useMeridianStore } from "../../store";
import type { MapAnomaly } from "../../types";

// Data hooks for the city panel: the seasonality strip (shares useMeridianStore.seasonality with When to go).

export type LoadStatus = "loading" | "ready" | "error";

export type SeasonState =
  | { status: "loading" }
  | { status: "ready"; months: SeasonMonth[] }
  | { status: "none" }
  | { status: "error"; unavailable: boolean };

export function useCitySeasonality(cityId: string): SeasonState & { retry: () => void } {
  const cached = useMeridianStore((s) => s.seasonality[cityId]);
  const [error, setError] = useState<null | { unavailable: boolean }>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    setError(null);
    fetchCitySeasonality(cityId)
      .then((months) => {
        useMeridianStore.getState().setSeasonality(cityId, months);
      })
      .catch((e) => {
        if (live) setError({ unavailable: e instanceof SeasonalityUnavailableError });
      });
    return () => {
      live = false;
    };
  }, [cityId, cached, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (cached === null) return { status: "none", retry };
  if (cached) return { status: "ready", months: cached, retry };
  if (error) return { status: "error", unavailable: error.unavailable, retry };
  return { status: "loading", retry };
}

// ── Place news (GET /api/news/place) ───────────────────────────────

export type NewsTopic = "transport" | "safety" | "unrest" | "governance" | "health" | "utilities" | "hazard" | "conflict";

export const TOPIC_LABELS: Record<NewsTopic, string> = {
  transport: "Transport",
  safety: "Crime and safety",
  unrest: "Strikes and unrest",
  governance: "Politics and corruption",
  health: "Health",
  utilities: "Power and water",
  hazard: "Natural hazards",
  conflict: "Conflict",
};

export interface PlaceNewsItem {
  title: string;
  source: string;
  url: string;
  pubDate: string;
  scope: "city" | "country";
  topics: NewsTopic[];
  severity: 1 | 2 | 3;
  /** Headline names the city or country. */
  mentions?: boolean;
}

export interface NewsFlag {
  topic: NewsTopic;
  count: number;
  severity: 1 | 2 | 3;
  headline: string;
  url: string;
  latest: string;
}

export type IssueSubject = "rail" | "air" | "road" | "sea" | "buildings" | "power" | "water" | "health" | "crime" | "unrest" | "politics";

/** A systemic problem detected from a country's headlines (server/lib/newsIssues.ts). */
export interface NewsIssue {
  subject: IssueSubject;
  label: string;
  level: "systemic" | "incident" | "recurring";
  incidents: number;
  deaths: number;
  linked: ("governance" | "unrest")[];
  headlineCount: number;
  firstSeen: string;
  lastSeen: string;
  headlines: { title: string; url: string; pubDate: string; source: string }[];
  summary: string;
}

/** News-flag topic an issue subject already covers. */
export const SUBJECT_TOPIC: Record<IssueSubject, NewsTopic | null> = {
  rail: "transport",
  air: "transport",
  road: "transport",
  sea: "transport",
  buildings: null,
  power: "utilities",
  water: "utilities",
  health: "health",
  crime: "safety",
  unrest: "unrest",
  politics: "governance",
};

export interface PlaceNews {
  available: boolean;
  items: PlaceNewsItem[];
  flags: NewsFlag[];
  issues: NewsIssue[];
  advisories: MapAnomaly[];
}

const placeNewsCache = new Map<string, { at: number; value: PlaceNews }>();
const PLACE_NEWS_TTL = 15 * 60 * 1000;

export function usePlaceNews(cityId: string) {
  const fresh = () => {
    const hit = placeNewsCache.get(cityId);
    return hit && Date.now() - hit.at < PLACE_NEWS_TTL ? hit.value : null;
  };
  const [data, setData] = useState<PlaceNews | null>(fresh);
  const [status, setStatus] = useState<LoadStatus>(() => (fresh() ? "ready" : "loading"));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const hit = fresh();
    if (hit) {
      setData(hit);
      setStatus("ready");
      return;
    }
    let live = true;
    setStatus("loading");
    fetch(apiUrl(`/api/news/place?cityId=${encodeURIComponent(cityId)}`))
      .then((r) => {
        if (!r.ok) throw new Error(`place news ${r.status}`);
        return r.json();
      })
      .then((b: Partial<PlaceNews>) => {
        const value: PlaceNews = {
          available: b.available === true,
          items: Array.isArray(b.items) ? b.items : [],
          flags: Array.isArray(b.flags) ? b.flags : [],
          issues: Array.isArray(b.issues) ? b.issues : [],
          advisories: Array.isArray(b.advisories) ? b.advisories : [],
        };
        placeNewsCache.set(cityId, { at: Date.now(), value });
        if (!live) return;
        setData(value);
        setStatus("ready");
      })
      .catch(() => live && setStatus("error"));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, status, retry };
}

/** "3 hours ago" for an ISO date. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? "Yesterday" : `${d} days ago`;
  const mo = Math.round(d / 30);
  return mo === 1 ? "A month ago" : `${mo} months ago`;
}

// ── News briefing (GET /api/news/brief) ────────────────────────────

export interface NewsBrief {
  overview: string;
  points: { title: string; level?: NewsIssue["level"]; text: string; sources: number[] }[];
  sources: { n: number; source: string; url: string; pubDate: string; title: string }[];
  by: "model" | "rules";
  generatedAt: string;
}

const briefCache = new Map<string, { at: number; value: NewsBrief | null }>();

/** null data with status "ready" = the news search is unavailable. */
export function useNewsBrief(cityId: string) {
  const fresh = () => {
    const hit = briefCache.get(cityId);
    return hit && Date.now() - hit.at < PLACE_NEWS_TTL ? hit : null;
  };
  const [data, setData] = useState<NewsBrief | null>(() => fresh()?.value ?? null);
  const [status, setStatus] = useState<LoadStatus>(() => (fresh() ? "ready" : "loading"));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const hit = fresh();
    if (hit) {
      setData(hit.value);
      setStatus("ready");
      return;
    }
    let live = true;
    setStatus("loading");
    fetch(apiUrl(`/api/news/brief?cityId=${encodeURIComponent(cityId)}`))
      .then((r) => {
        if (!r.ok) throw new Error(`brief ${r.status}`);
        return r.json();
      })
      .then((b: { available?: boolean; brief?: NewsBrief }) => {
        const value = b.available && b.brief && typeof b.brief.overview === "string" ? b.brief : null;
        briefCache.set(cityId, { at: Date.now(), value });
        if (!live) return;
        setData(value);
        setStatus("ready");
      })
      .catch(() => live && setStatus("error"));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, status, retry };
}
