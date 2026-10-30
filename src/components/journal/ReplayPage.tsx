import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import { JournalApiError, getJourney, runReplay } from "../../lib/journalApi";
import { MONTHS, cityIndex } from "../../lib/journal";
import { MATCH_LABELS, resultKey } from "../../lib/replayGrid";
import {
  DEFAULT_CONTROLS,
  buildQuery,
  narrowQuery,
  querySummary,
  shiftMonth,
  templateFingerprint,
  templateMonth,
  type ReplayControls as Controls,
  type ReplayTemplateRef,
} from "../../lib/replayQuery";
import type { City, Journey, ReplayResponse, ReplayResult, Watch } from "../../types";
import ReplayControls from "./ReplayControls";
import ReplayGrid from "./ReplayGrid";
import ReplayResultList from "./ReplayResultList";
import WatchSheet from "./WatchSheet";

const DEBOUNCE_MS = 350;
const FLASH_MS = 2000;

type Failure = { kind: "template_not_found" | "template_not_fingerprinted" | "other"; message: string };

function toFailure(e: unknown): Failure {
  if (e instanceof JournalApiError) {
    if (e.code === "template_not_found") return { kind: "template_not_found", message: e.message };
    if (e.code === "template_not_fingerprinted") return { kind: "template_not_fingerprinted", message: e.message };
  }
  return { kind: "other", message: "" };
}

/** Best rated first, then newest. */
function selectable(journeys: Journey[], routeId?: string): Journey[] {
  const list = journeys
    .filter((j) => j.status === "confirmed" || j.id === routeId)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.startDate.localeCompare(a.startDate));
  return list;
}

const SCORED_LABEL = (r: ReplayResult): string[] => {
  const s = new Set(r.scoredOn);
  const out: string[] = [];
  if (["month", "comfort", "tempC", "precipMm"].some((d) => s.has(d as never))) out.push("CLIMATE");
  if (s.has("dailySpendEur")) out.push("SPEND");
  if (s.has("crowdProxy")) out.push("CROWD");
  if (s.has("flightCostEurPer1000km")) out.push("FLIGHT");
  return out;
};

function Legend() {
  return (
    <div className="heat-legend">
      <span className="hl-label">MATCH</span>
      <div className="hl-swatches">
        {MATCH_LABELS.map((word, bin) => (
          <div key={word} className="hl-sw">
            <div className="block" style={{ background: `var(--heat-b${bin})` }} />
            <div className="word">{word}</div>
          </div>
        ))}
      </div>
      <div className="hl-sep" />
      <div className="hl-key">
        <div className="block jr-tpl" style={{ background: "var(--heat-b3)" }} />
        <span>TEMPLATE MONTH</span>
      </div>
      <div className="hl-key">
        <div className="block jr-legend-ev" />
        <span>EVENT</span>
      </div>
    </div>
  );
}

const Skeleton = () => (
  <div role="status" aria-busy="true" aria-label="Loading replay">
    {Array.from({ length: 8 }, (_, i) => (
      <span key={i} className="jr-skel jr-skel-line" />
    ))}
  </div>
);

/** #/journal/replay(/:id(/:stop)): find another window like a journey (DESIGN-journal §7). */
export default function ReplayPage({
  journeyId,
  stopIndex,
  error,
  onRetry,
}: {
  journeyId?: string;
  stopIndex?: number;
  /** The journal list failed to load. */
  error?: Error | null;
  onRetry?: () => void;
}) {
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys);
  const selectCity = useMeridianStore((s) => s.selectCity);
  const createTrip = useMeridianStore((s) => s.createTrip);
  const addCityToTrip = useMeridianStore((s) => s.addCityToTrip);
  const cityById = useMemo(() => cityIndex(cities), [cities]);

  const options = useMemo(() => selectable(journeys ?? [], journeyId), [journeys, journeyId]);
  const [chosen, setChosen] = useState<ReplayTemplateRef | null>(journeyId ? { journeyId, stopIndex: stopIndex ?? null } : null);
  useEffect(() => {
    setChosen(journeyId ? { journeyId, stopIndex: stopIndex ?? null } : null);
  }, [journeyId, stopIndex]);
  const template: ReplayTemplateRef | null = chosen ?? (options[0] ? { journeyId: options[0].id, stopIndex: null } : null);
  const tplId = template?.journeyId;
  const tplStop = template?.stopIndex ?? null;

  // The list copy may predate the server's fingerprint: fetch the template fresh, again once a replay has run.
  const stored = journeys?.find((j) => j.id === tplId);
  const [fresh, setFresh] = useState<Journey | null>(null);
  const [resp, setResp] = useState<ReplayResponse | null>(null);
  const journey = fresh && fresh.id === tplId ? fresh : stored;
  useEffect(() => {
    if (!tplId) return;
    let live = true;
    getJourney(tplId)
      .then((j) => live && setFresh(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tplId, !!resp]);

  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  // The first run for a template (and a retry) goes out at once; every later change is debounced.
  const immediate = useRef(true);
  const lastTpl = useRef(tplId);
  const doRetry = () => {
    immediate.current = true;
    setRetry((n) => n + 1);
  };

  const query = useMemo(() => (tplId ? buildQuery(controls, { journeyId: tplId, stopIndex: tplStop }) : null), [controls, tplId, tplStop]);
  const queryKey = JSON.stringify(query);

  // 350ms debounce, the previous request aborted; results stay in place while re-ranking.
  useEffect(() => {
    if (!query) return;
    const ctl = new AbortController();
    if (lastTpl.current !== tplId) {
      lastTpl.current = tplId;
      immediate.current = true;
    }
    const delay = immediate.current ? 0 : DEBOUNCE_MS;
    immediate.current = false;
    setLoading(true);
    const timer = setTimeout(
      async () => {
        try {
          const r = await runReplay(query, ctl.signal);
          if (ctl.signal.aborted) return; // a body cut off by the abort resolves as null
          setResp(r);
          setFailure(null);
          setLoading(false);
        } catch (e) {
          if (ctl.signal.aborted) return;
          const f = toFailure(e);
          // Results for a template that cannot be matched would mislead; keep them for transient errors only.
          if (f.kind !== "other") setResp(null);
          setFailure(f);
          setLoading(false);
        }
      },
      delay
    );
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retry]);

  // ── Selection, hover, announcements ─────────────────────────────
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverCityId, setHoverCityId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const lastTop = useRef<string | null>(null);
  useEffect(() => {
    if (!resp) return;
    setSelectedKey((k) => (k && resp.results.some((r) => resultKey(r) === k) ? k : null));
    const top = resp.results[0];
    const topKey = top ? resultKey(top) : null;
    if (top && topKey !== lastTop.current && lastTop.current !== null) {
      setAnnounce(`Re-ranked: ${cityById.get(top.cityId)?.name ?? top.cityId} in ${MONTHS[top.month - 1]} now first`);
    }
    lastTop.current = topKey;
  }, [resp, cityById]);

  const selectedCityId = selectedKey ? selectedKey.split(":")[0]! : null;
  const pick = (cityId: string, month?: number) => {
    const rs = resp?.results ?? [];
    const hit = rs.find((r) => r.cityId === cityId && r.month === month) ?? rs.find((r) => r.cityId === cityId);
    setSelectedKey(hit ? resultKey(hit) : null);
  };
  const goto = (cityId: string) => {
    selectCity(cityId);
    navigate("/");
  };

  const repeat = (r: ReplayResult) => {
    const c = cityById.get(r.cityId);
    if (!c) return;
    const node = (x: City) => ({ cityId: x.id, name: x.name, iata: x.iata, lat: x.lat, lng: x.lng });
    const id = createTrip(`${c.name} · ${MONTHS[r.month - 1]}`);
    const from = resp?.fromCityId ? cityById.get(resp.fromCityId) : undefined;
    if (from) addCityToTrip(id, node(from));
    addCityToTrip(id, node(c));
    navigate(`/trips/${id}`);
  };

  // ── Watch ───────────────────────────────────────────────────────
  const [watch, setWatch] = useState<{ key: string; label: string; query: NonNullable<typeof query>; summary: string } | null>(null);
  const [watchedKey, setWatchedKey] = useState<string | null>(null);
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flash.current), []);
  const tplMonth = templateMonth(journey, tplStop);
  const tplTitle = `${journey?.title ?? "journey"}${tplMonth ? ` ${MONTHS[tplMonth - 1]}` : ""}`;
  const openWatch = (r?: ReplayResult) => {
    if (!query) return;
    const q = r ? narrowQuery(query, r.cityId, r.month) : query;
    const where = r ? ` → ${cityById.get(r.cityId)?.name ?? r.cityId} ${MONTHS[r.month - 1]}` : "";
    setWatch({ key: r ? resultKey(r) : "query", label: `Like ${tplTitle}${where}`, query: q, summary: querySummary(q, tplTitle) });
  };
  const watchSaved = (_w: Watch) => {
    if (!watch) return;
    setWatchedKey(watch.key);
    setWatch(null);
    clearTimeout(flash.current);
    flash.current = setTimeout(() => setWatchedKey(null), FLASH_MS);
  };

  // ── Render ──────────────────────────────────────────────────────
  const targetMonth = tplMonth && !controls.anyMonth && controls.monthShift !== 0 ? shiftMonth(tplMonth, controls.monthShift) : undefined;
  const fromCity = resp?.fromCityId ? cityById.get(resp.fromCityId) : undefined;
  const thin = resp ? resp.universeSize < 60 : false;
  const scored = resp?.results[0] ? SCORED_LABEL(resp.results[0]) : [];

  if (journeys && !template) {
    return (
      <div className="jr-replay">
        <header className="jr-rp-head">
          <div className="jr-eyebrow">REPLAY · FIND ANOTHER WINDOW LIKE…</div>
          <h1 className="jr-title">Replay</h1>
        </header>
        <div className="jr-empty">
          <div className="cmd-empty-title">Nothing to replay yet.</div>
          <div className="jr-empty-sub">LOG A JOURNEY FIRST — REPLAY USES IT AS THE TEMPLATE.</div>
          <button type="button" className="booking-primary-btn" onClick={() => useMeridianStore.getState().openQuickLog()}>
            + LOG JOURNEY
          </button>
        </div>
      </div>
    );
  }

  if (!journeys && !template && error) {
    return (
      <div className="jr-replay">
        <div className="jr-empty" role="alert">
          <div className="bk-error-title">⚠ COULDN'T LOAD THE JOURNAL</div>
          <button type="button" className="tm-action-btn" onClick={onRetry}>
            ↻ RETRY
          </button>
        </div>
      </div>
    );
  }

  const blocking = failure && failure.kind !== "other" ? failure : null;
  const stale = loading && !!resp;

  return (
    <div className="jr-replay">
      <header className="jr-rp-head">
        <div className="jr-eyebrow">REPLAY · FIND ANOTHER WINDOW LIKE…</div>
        <h1 className="jr-title">Replay</h1>
        <p className="jr-rp-disc">
          {resp ? (
            <>
              CLIMATE STAGE · {resp.universeSize} CITIES × 12 MONTHS
              {fromCity ? ` · PRICES FOR TOP 20 FROM ${fromCity.iata ?? fromCity.name.toUpperCase()}` : " · NO ORIGIN SET — NO PRICES"}
              {scored.length > 0 && ` · SCORED ON ${scored.join(", ")}`}
              {resp.templateClimate === "normal" && " · CLIMATE FROM CITY NORMALS"}
              {thin && <span className="jr-rp-thin"> · THIN COVERAGE — RESULTS LIMITED TO CACHED CITIES</span>}
            </>
          ) : (
            "CLIMATE STAGE · 12 MONTHS · PRICES FOR THE TOP 20"
          )}
        </p>
        <div className="jr-rp-status">
          {loading && (
            <span className="jr-checking">
              RE-RANKING… <span className="agent-brief-loading"><span /><span /><span /></span>
            </span>
          )}
          {!loading && failure?.kind === "other" && resp && (
            <span className="jr-err">
              ⚠ RE-RANK FAILED ·{" "}
              <button type="button" className="tp-link" onClick={() => doRetry()}>
                ↻ RETRY
              </button>
            </span>
          )}
        </div>
        <div className="jr-sr-only" aria-live="polite">
          {announce}
        </div>
      </header>

      {resp?.templateClimate === "normal" && (
        <div className="jr-draft-strip" role="status">
          {templateFingerprint(journey, tplStop)?.status.tempC === "pending"
            ? "TEMPLATE WEATHER STILL LOADING — CLIMATE SCORED ON SEASON NORMALS ONLY"
            : "TEMPLATE WEATHER UNAVAILABLE — CLIMATE SCORED ON SEASON NORMALS ONLY"}
        </div>
      )}

      <div className="jr-rp-grid">
        {template && (
          <ReplayControls
            journeys={options}
            journey={journey}
            template={template}
            controls={controls}
            templateClimate={resp?.templateClimate}
            fromCityId={resp?.fromCityId}
            cities={cities}
            onTemplate={(t) => navigate(`/journal/replay/${encodeURIComponent(t.journeyId)}${t.stopIndex !== null ? `/${t.stopIndex}` : ""}`)}
            onChange={setControls}
          />
        )}

        <div className={`jr-rp-center${stale ? " stale" : ""}`}>
          {blocking ? (
            <div className="jr-empty" role="alert">
              <div className="bk-error-title">
                {blocking.kind === "template_not_found" ? "⚠ TEMPLATE NOT FOUND" : "⚠ TEMPLATE HAS NO FINGERPRINT YET"}
              </div>
              <div className="jr-empty-sub">
                {blocking.kind === "template_not_found"
                  ? "That journey no longer exists. Pick another template."
                  : "Its weather and spend couldn't be worked out yet. Try again in a moment."}
              </div>
              {blocking.kind === "template_not_fingerprinted" && (
                <button type="button" className="tm-action-btn" onClick={() => doRetry()}>
                  ↻ RETRY
                </button>
              )}
            </div>
          ) : failure && !resp ? (
            <div className="jr-empty" role="alert">
              <div className="bk-error-title">⚠ COULDN'T RUN THE REPLAY</div>
              <button type="button" className="tm-action-btn" onClick={() => doRetry()}>
                ↻ RETRY
              </button>
            </div>
          ) : !resp ? (
            <Skeleton />
          ) : resp.results.length === 0 ? (
            <div className="jr-empty">
              <div className="cmd-empty-title">NOTHING CLEARS THESE LIMITS</div>
              <div className="cmd-empty-sub">Loosen month, flight time or event filters.</div>
            </div>
          ) : (
            <>
              <Legend />
              <ReplayGrid
                resp={resp}
                cityById={cityById}
                templateMonth={tplMonth}
                targetMonth={targetMonth}
                selectedCityId={selectedCityId}
                hoverCityId={hoverCityId}
                onSelect={pick}
                onGoto={goto}
              />
            </>
          )}
        </div>

        <div className={`jr-rp-right${stale ? " stale" : ""}`}>
          {resp && resp.results.length > 0 ? (
            <ReplayResultList
              results={resp.results}
              cityById={cityById}
              selectedKey={selectedKey}
              watchedKey={watchedKey}
              onSelect={(r) => setSelectedKey(resultKey(r))}
              onHover={setHoverCityId}
              onRepeat={repeat}
              onWatch={openWatch}
            />
          ) : (
            !blocking && !failure && (
              <div aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <span key={i} className="jr-skel jr-skel-line" />
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {watch && <WatchSheet label={watch.label} query={watch.query} summary={watch.summary} onClose={() => setWatch(null)} onSaved={watchSaved} />}
    </div>
  );
}

