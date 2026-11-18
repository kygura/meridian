// HTTP client for the Meridian Atlas API (/api/atlas, ADR 0020).
// Request types are the server's zod input types and response types are read off the server's
// own functions. Every import from the server is type-only: nothing of it loads at runtime.

import type { z } from "zod";
import type {
  AtlasConfig,
  atlasConfigSchema,
  atlasNotifyInputSchema,
  fireInputSchema,
  importInputSchema,
  signalInputSchema,
  wishlistPatchSchema,
  AtlasPlace,
  AtlasSignal,
  DiscoveryInput,
  PlaceRef,
  ScanInput,
  TripPlanInput,
  WishlistEntryInput
} from "../../server/lib/atlas/schemas";
import type {
  RunSummary,
  TripIdea,
  buildContext,
  createTripFromPlan,
  getConfig,
  importLegacy,
  recordDiscovery,
  recordScan,
  routeFares,
  seasonalRanking,
  upsertWishlist,
  Unresolved
} from "../../server/lib/atlas/service";
import type { ScoredFlight, WatchHit } from "../../server/lib/atlas/scoring";
import type { NotifyResult } from "../../server/lib/notifier";

export type {
  AtlasConfig,
  AtlasPlace,
  AtlasSignal,
  DiscoveryInput,
  PlaceRef,
  RunSummary,
  ScanInput,
  ScoredFlight,
  TripIdea,
  TripPlanInput,
  Unresolved,
  WatchHit,
  WishlistEntryInput
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type AtlasConfigPatch = DeepPartial<z.input<typeof atlasConfigSchema>>;
export type NotifyInput = z.input<typeof atlasNotifyInputSchema>;
/** The server takes config as unknown and validates it; the CLI builds it as a config patch. */
export type ImportInput = Omit<z.input<typeof importInputSchema>, "config"> & { config?: AtlasConfigPatch };
export type SignalInput = z.input<typeof signalInputSchema>;
export type FireInput = z.input<typeof fireInputSchema>;
export type WishlistPatch = z.input<typeof wishlistPatchSchema>;
export type PartialRange = { min?: number; max?: number };
export type ImportFare = NonNullable<ImportInput["fares"]>[number];

export type NoticeKind = NotifyInput["kind"];
export const NOTICE_KINDS: readonly NoticeKind[] = ["digest", "deal", "trip", "watch", "discovery"];

export type ContextResponse = Awaited<ReturnType<typeof buildContext>>;
export type OriginSource = ContextResponse["origin"]["source"];
export type StaySummary = NonNullable<ContextResponse["rotation"]["current"]>;
export type ConfigResponse = Awaited<ReturnType<typeof getConfig>>;
export type SeasonalResponse = Awaited<ReturnType<typeof seasonalRanking>>;
export type SeasonalQuery = { months: number[]; vibe?: string[]; profile?: string; limit?: number };
export type WishlistResponse = { entries: AtlasPlace[] };
export type WishlistUpsertResponse = Awaited<ReturnType<typeof upsertWishlist>>;
export type WishlistRemoveResponse = { removed: boolean };
export type WishlistPatchResponse = { entry: AtlasPlace };
export type ScanResponse = Awaited<ReturnType<typeof recordScan>>;
export type DiscoveryResponse = Awaited<ReturnType<typeof recordDiscovery>>;
export type TripResponse = Awaited<ReturnType<typeof createTripFromPlan>>;
export type NotifyResponse = NotifyResult;
export type RunsResponse = { runs: RunSummary[] };
export type RunResponse = { run: RunSummary };
export type FaresResponse = Awaited<ReturnType<typeof routeFares>>;
export type ImportResponse = Awaited<ReturnType<typeof importLegacy>>;
export type SignalsResponse = { signals: AtlasSignal[] };
export type SignalsAddResponse = { stored: number; unresolved: Unresolved[] };
export type HealthResponse = { status?: string; timestamp?: string; [key: string]: unknown };

export class MeridianError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "MeridianError";
    this.status = status;
    this.body = body;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MeridianClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  /** Waits between a 429/503 and its single retry. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 10_000;

/** Milliseconds to wait before the retry: the server's retry-after, capped, else 2 s. */
export function retryDelayMs(res: Response, body: unknown, now: number = Date.now()): number {
  const header = res.headers.get("retry-after");
  let seconds: number | null = null;
  if (header) {
    const numeric = Number(header);
    if (Number.isFinite(numeric)) {
      seconds = numeric;
    } else {
      const at = Date.parse(header);
      if (Number.isFinite(at)) seconds = (at - now) / 1000;
    }
  }
  if (seconds === null && body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const raw = b.retryAfter ?? b.retry_after;
    if (typeof raw === "number" && Number.isFinite(raw)) seconds = raw;
  }
  if (seconds === null) return DEFAULT_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(0, Math.round(seconds * 1000)));
}

function describeError(status: number, statusText: string, body: unknown, method: string, path: string): string {
  let detail = statusText;
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    detail = (body as Record<string, string>).error;
  } else if (typeof body === "string" && body.trim()) {
    detail = body.trim().slice(0, 200);
  }
  return `${method} ${path} failed: ${status} ${detail}`.trim();
}

export function createMeridianClient(options: MeridianClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, init);
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (res.ok) return parsed as T;
      if (attempt === 0 && (res.status === 429 || res.status === 503)) {
        await sleep(retryDelayMs(res, parsed));
        continue;
      }
      throw new MeridianError(res.status, parsed, describeError(res.status, res.statusText, parsed, method, path));
    }
  }

  function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const s = search.toString();
    return s ? `?${s}` : "";
  }

  return {
    baseUrl,
    health: () => request<HealthResponse>("GET", "/api/health"),
    context: (today?: string) => request<ContextResponse>("GET", `/api/atlas/context${query({ today })}`),
    seasonal: (q: SeasonalQuery) =>
      request<SeasonalResponse>(
        "GET",
        `/api/atlas/seasonal${query({
          months: q.months.join(","),
          vibe: q.vibe?.join(","),
          profile: q.profile,
          limit: q.limit
        })}`
      ),
    getConfig: () => request<ConfigResponse>("GET", "/api/atlas/config"),
    patchConfig: (patch: AtlasConfigPatch) => request<ConfigResponse>("PATCH", "/api/atlas/config", patch),
    putConfig: (config: AtlasConfig) => request<ConfigResponse>("PUT", "/api/atlas/config", config),
    listWishlist: () => request<WishlistResponse>("GET", "/api/atlas/wishlist"),
    upsertWishlist: (entries: WishlistEntryInput[]) =>
      request<WishlistUpsertResponse>("POST", "/api/atlas/wishlist", { entries }),
    patchWishlist: (cityId: string, patch: WishlistPatch) =>
      request<WishlistPatchResponse>("PATCH", `/api/atlas/wishlist/${encodeURIComponent(cityId)}`, patch),
    removeWishlist: (cityId: string) =>
      request<WishlistRemoveResponse>("DELETE", `/api/atlas/wishlist/${encodeURIComponent(cityId)}`),
    scan: (input: ScanInput) => request<ScanResponse>("POST", "/api/atlas/scans", input),
    discover: (input: DiscoveryInput) => request<DiscoveryResponse>("POST", "/api/atlas/discoveries", input),
    trip: (input: TripPlanInput) => request<TripResponse>("POST", "/api/atlas/trips", input),
    notify: (input: NotifyInput) => request<NotifyResponse>("POST", "/api/atlas/notify", input),
    signals: (cityId?: string) => request<SignalsResponse>("GET", `/api/atlas/signals${query({ cityId })}`),
    addSignals: (signals: SignalInput[]) => request<SignalsAddResponse>("POST", "/api/atlas/signals", { signals }),
    fire: (input: FireInput) => request<RunResponse>("POST", "/api/atlas/run", input),
    runs: (limit?: number) => request<RunsResponse>("GET", `/api/atlas/runs${query({ limit })}`),
    fares: (route: string) => request<FaresResponse>("GET", `/api/atlas/fares${query({ route })}`),
    importLegacy: (input: ImportInput) => request<ImportResponse>("POST", "/api/atlas/import", input)
  };
}

export type MeridianClient = ReturnType<typeof createMeridianClient>;

export function clientFromEnv(
  overrides: { url?: string; token?: string; fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  env: Record<string, string | undefined> = process.env
): MeridianClient {
  const baseUrl = overrides.url || env.MERIDIAN_URL;
  const token = overrides.token || env.MERIDIAN_TOKEN;
  const missing: string[] = [];
  if (!baseUrl) missing.push("MERIDIAN_URL (or --url)");
  if (!token) missing.push("MERIDIAN_TOKEN (or --token)");
  if (missing.length > 0 || !baseUrl || !token) {
    throw new Error(`Missing Meridian settings: ${missing.join(", ")}. Set them in the environment or .env.`);
  }
  return createMeridianClient({ baseUrl, token, fetch: overrides.fetch, sleep: overrides.sleep });
}
