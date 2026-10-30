import { useEffect, useMemo, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import {
  deleteJourney,
  getFingerprint,
  getJourney,
  JournalLockedError,
  saveJourney,
} from "../../lib/journalApi";
import {
  MODE_GLYPH,
  cityIndex,
  cityLabel,
  formatDay,
  formatMoney,
  formatRangeLong,
  formatWhen,
  itinerary,
  journeyNights,
  legKm,
  plural,
  stopNights,
  type CityIndex,
} from "../../lib/journal";
import { fromJourney, toJourneyInput } from "../../lib/journalForm";
import type { Experience, Fingerprint, Journey, Segment, Stop } from "../../types";
import RatingPips from "./RatingPips";
import ProvenanceChip from "./ProvenanceChip";
import FingerprintPanel from "./FingerprintPanel";

const POLL_MS = 20_000;
const MAX_POLLS = 3;

type Load = "loading" | "ready" | "missing" | "error";

export default function JourneyDetail({ journeyId }: { journeyId: string }) {
  const cities = useMeridianStore((s) => s.cities);
  const stored = useMeridianStore((s) => s.journeys?.find((j) => j.id === journeyId));
  const upsertJourney = useMeridianStore((s) => s.upsertJourney);
  const removeJourney = useMeridianStore((s) => s.removeJourney);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const createTrip = useMeridianStore((s) => s.createTrip);
  const addCityToTrip = useMeridianStore((s) => s.addCityToTrip);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);

  const [fetched, setFetched] = useState<Journey | null>(null);
  const [load, setLoad] = useState<Load>(stored ? "ready" : "loading");
  const [stopIndex, setStopIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [polled, setPolled] = useState<{ fp: Fingerprint; at: string } | null>(null);
  const [tick, setTick] = useState(0);

  // Always fetch the single journey once: it carries the freshest fingerprint.
  useEffect(() => {
    let live = true;
    getJourney(journeyId)
      .then((j) => {
        if (!live) return;
        if (!j) {
          removeJourney(journeyId);
          return setLoad("missing");
        }
        setFetched(j);
        setLoad("ready");
        if (useMeridianStore.getState().journeys) upsertJourney(j);
      })
      .catch((e) => {
        if (live && !(e instanceof JournalLockedError)) setLoad((l) => (l === "ready" ? l : "error"));
      });
    return () => {
      live = false;
    };
  }, [journeyId, tick, upsertJourney, removeJourney]);

  const journey = stored ?? (fetched?.id === journeyId ? fetched : null);
  // A polled fingerprint only counts for the version of the journey it was fetched for.
  const at = journey?.updatedAt;
  const fp = polled && polled.at === at ? polled.fp : journey?.fingerprint;
  const pending = !!fp && Object.values(fp.status).includes("pending");

  // A pending fingerprint is re-read at 20s, up to 3 times, while the page is mounted.
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      getFingerprint(journeyId)
        .then((f) => f && at && setPolled({ fp: f, at }))
        .catch(() => {});
      if (tries >= MAX_POLLS) clearInterval(id);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, journeyId, at]);

  if (!journey) {
    return (
      <div className="jr-detail">
        <button type="button" className="tp-link" onClick={() => navigate("/journal")}>← LOGBOOK</button>
        {load === "loading" && (
          <div role="status" aria-busy="true" aria-label="Loading journey">
            <span className="jr-skel jr-skel-year" />
            {[0, 1, 2].map((i) => <span key={i} className="jr-skel jr-skel-line" />)}
          </div>
        )}
        {load === "missing" && <div className="jr-empty"><div className="cmd-empty-title">NO SUCH JOURNEY</div></div>}
        {load === "error" && (
          <div className="jr-empty" role="alert">
            <div className="bk-error-title">⚠ COULDN'T LOAD THIS JOURNEY</div>
            <button type="button" className="tm-action-btn" onClick={() => { setLoad("loading"); setTick((t) => t + 1); }}>↻ RETRY</button>
          </div>
        )}
      </div>
    );
  }

  const j = journey;
  const it = itinerary(j);
  const nights = journeyNights(j);
  const findSimilar = () =>
    navigate(`/journal/replay/${encodeURIComponent(j.id)}${stopIndex !== null ? `/${stopIndex}` : ""}`);

  const repeat = () => {
    const tripId = createTrip(j.title);
    for (const s of j.stops) {
      const c = cityIdx.get(s.cityId);
      if (c) addCityToTrip(tripId, { cityId: c.id, name: c.name, iata: c.iata, lat: c.lat, lng: c.lng });
    }
    navigate(`/trips/${tripId}`);
  };

  const remove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await deleteJourney(j.id);
      removeJourney(j.id);
      navigate("/journal");
    } catch {
      setBusy(false);
      setConfirmDelete(false);
      setActionError("⚠ COULDN'T DELETE — TRY AGAIN");
    }
  };

  const confirmDraft = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const input = { ...toJourneyInput(fromJourney(j), (id) => cityIdx.get(id)?.name ?? id), status: "confirmed" as const };
      upsertJourney(await saveJourney(input, j.id));
    } catch {
      setActionError("⚠ COULDN'T CONFIRM — TRY AGAIN");
    }
    setBusy(false);
  };

  const stopFp = stopIndex !== null ? j.stops[stopIndex]?.fingerprint : undefined;

  return (
    <div className="jr-detail">
      <button type="button" className="tp-link" onClick={() => navigate("/journal")}>← LOGBOOK</button>

      <header className="jr-d-head">
        <div className="jr-d-titles">
          <h1 className="jr-d-title">{j.title}</h1>
          <div className="jr-d-meta">
            {formatRangeLong(j.startDate, j.endDate)} · {plural(nights, "NIGHT")}
            {j.companions ? ` · ${plural(j.companions, "TRAVELLER")}` : ""}
          </div>
          <div className="jr-d-meta">
            <RatingPips value={j.rating} />
            {j.tags.map((t) => <span key={t} className="jr-pill">{t}</span>)}
          </div>
        </div>
        <div className="jr-d-actions">
          <button type="button" className="tm-action-btn" onClick={() => openQuickLog({ journeyId: j.id })}>EDIT</button>
          <button type="button" className="booking-primary-btn" onClick={findSimilar}>FIND SIMILAR ↗</button>
          <button type="button" className="tm-action-btn" disabled={cityIdx.size === 0} onClick={repeat}>↻ REPEAT</button>
          {confirmDelete ? (
            <>
              <button type="button" className="tm-action-btn tm-delete-btn tm-delete-confirm" disabled={busy} autoFocus onClick={() => void remove()}>CONFIRM DELETE</button>
              <button type="button" className="tm-action-btn" onClick={() => setConfirmDelete(false)}>KEEP</button>
            </>
          ) : (
            <button type="button" className="tm-action-btn tm-delete-btn" onClick={() => setConfirmDelete(true)}>DELETE</button>
          )}
        </div>
      </header>

      {actionError && <div className="jr-err" role="alert">{actionError}</div>}
      {j.status === "draft" && (
        <div className="jr-draft-strip" role="status">
          <span>DRAFT · NOT YET CONFIRMED</span>
          <button type="button" className="tm-action-btn" disabled={busy} onClick={() => void confirmDraft()}>CONFIRM</button>
        </div>
      )}

      <div className="jr-d-grid">
        <div className="jr-itin">
          {j.stops.map((s, i) => (
            <div key={i}>
              <StopNode stop={s} index={i} cities={cityIdx} selected={stopIndex === i} onSelect={() => setStopIndex(stopIndex === i ? null : i)} hideManual={j.provenance.source === "manual"} />
              {it.doneByStop[i].length > 0 && (
                <>
                  <div className="jr-label jr-done-label">DONE</div>
                  <Done items={it.doneByStop[i]} />
                </>
              )}
              {i < j.stops.length - 1 && (it.legs[i] ? <Leg seg={it.legs[i]!} cities={cityIdx} /> : <div className="jr-leg-gap" />)}
            </div>
          ))}

          {it.other.length > 0 && (
            <div className="jr-block">
              <div className="jr-label">OTHER SEGMENTS</div>
              {it.other.map((g, i) => <Leg key={i} seg={g} cities={cityIdx} named />)}
            </div>
          )}
          {it.doneOther.length > 0 && (
            <div className="jr-block">
              <div className="jr-label">DONE · ELSEWHERE</div>
              <Done items={it.doneOther} cities={cityIdx} />
            </div>
          )}
          {j.notes && (
            <div className="jr-block">
              <div className="jr-label">NOTES</div>
              <div className="jr-notes">{j.notes}</div>
            </div>
          )}
        </div>

        <FingerprintPanel
          journey={j}
          stopIndex={stopIndex}
          stopName={stopIndex !== null ? cityIdx.get(j.stops[stopIndex]?.cityId)?.name : undefined}
          fingerprint={stopIndex !== null ? stopFp : fp}
          onClearStop={() => setStopIndex(null)}
          onFindSimilar={findSimilar}
        />
      </div>
    </div>
  );
}

function StopNode({ stop: s, index, cities, selected, onSelect, hideManual }: {
  stop: Stop; index: number; cities: CityIndex; selected: boolean; onSelect: () => void; hideManual: boolean;
}) {
  const c = cities.get(s.cityId);
  const nights = stopNights(s);
  return (
    <div className={`jr-node${selected ? " on" : ""}`}>
      <button type="button" className="jr-node-main" aria-pressed={selected} aria-label={`Stop ${index + 1}: ${c?.name ?? s.cityId}. Show its fingerprint`} onClick={onSelect}>
        <span className="jr-node-n">{index + 1}</span>
        <span className="jr-node-iata">{c?.iata ?? "—"}</span>
        <span className="jr-node-name">{c?.name ?? s.cityId}</span>
        <span className="jr-node-dates">ARR {formatDay(s.arrive)} · DEP {formatDay(s.depart)} · {plural(nights, "NIGHT")}</span>
        <RatingPips value={s.rating} />
      </button>
      {s.lodging && (
        <div className="jr-node-line">
          <span className="jr-label">STAY</span>
          <span>{s.lodging.name}{s.lodging.kind ? ` · ${s.lodging.kind.toUpperCase()}` : ""} · {formatMoney(s.lodging.cost)}</span>
          {!(hideManual && s.lodging.provenance.source === "manual") && <ProvenanceChip provenance={s.lodging.provenance} />}
        </div>
      )}
      {s.crowdOverride !== undefined && (
        <div className="jr-node-line"><span className="jr-label">CROWD · YOUR CALL {s.crowdOverride}</span></div>
      )}
    </div>
  );
}

function Leg({ seg: g, cities, named }: { seg: Segment; cities: CityIndex; named?: boolean }) {
  const km = legKm(g, cities);
  const id = [g.number, g.carrier].filter(Boolean).join(" · ");
  return (
    <div className={`tp-leg jr-leg${g.mode === "flight" ? "" : " dashed"}`}>
      <span className="tp-leg-line" aria-hidden="true" />
      <span role="img" aria-label={g.mode}>{MODE_GLYPH[g.mode]}</span>
      {named && <span>{cityLabel(g.fromCityId, cities)} → {cityLabel(g.toCityId, cities)}</span>}
      {id && <span>{id}</span>}
      <span>{formatWhen(g.departAt)}</span>
      {km !== undefined && <span>{Math.round(km).toLocaleString("en-US")} KM</span>}
      {g.cost && <span>{formatMoney(g.cost)}</span>}
      <ProvenanceChip provenance={g.provenance} />
    </div>
  );
}

function Done({ items, cities }: { items: Experience[]; cities?: CityIndex }) {
  return (
    <ul className="jr-done" aria-label="Done">
      {items.map((x, i) => (
        <li key={i}>
          <span className="jr-label">{formatDay(x.date)}</span>
          <span className="jr-done-title">{x.title}</span>
          {cities && <span className="jr-label">{cityLabel(x.cityId, cities)}</span>}
          {x.kind && <span className="jr-pill">{x.kind}</span>}
          {x.cost && <span>{formatMoney(x.cost)}</span>}
          <RatingPips value={x.rating} />
          <ProvenanceChip provenance={x.provenance} />
        </li>
      ))}
    </ul>
  );
}
