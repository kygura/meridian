import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { navigate } from "../../../lib/router";
import { setWatchPrefill } from "../../../lib/watchPrefill";
import {
  JournalApiError,
  JournalLockedError,
  deleteJourney,
  getFingerprint,
  getJourney,
  saveJourney,
} from "../../../lib/journalApi";
import { cityIndex, itinerary, journeyNights } from "../../../lib/journal";
import { fromJourney, toJourneyInput } from "../../../lib/journalForm";
import type { Journey } from "../../../types";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Popover,
  Skeleton,
  UnlockCard,
  toast,
  useJournalToken,
} from "../../../ui";
import { IconBell, IconCalendar, IconEdit, IconInfo, IconMore, IconRefresh, IconTrash, IconTrips } from "../../../ui/icons";
import { Stars } from "./Rating";
import { ExperienceItem, FingerprintCard, SegmentItem, SpendCard, StopCard } from "./Conditions";
import { plural, range } from "./format";
import "./past.css";

export interface JourneyDetailProps {
  /** Journey id from #/trips/past/<journeyId>. */
  journeyId: string;
}

const POLL_MS = 20_000;
const MAX_POLLS = 3;
const BACK = { label: "Past trips", href: "#/trips/past" };

type Load = "loading" | "ready" | "missing" | "error";

/** #/trips/past/<journeyId>: header with edit, stops with conditions, fingerprint, segments, experiences. */
export default function JourneyDetail({ journeyId }: JourneyDetailProps) {
  const { token, unlocked } = useJournalToken();
  const cities = useMeridianStore((s) => s.cities);
  const stored = useMeridianStore((s) => s.journeys?.find((j) => j.id === journeyId));
  const upsertJourney = useMeridianStore((s) => s.upsertJourney);
  const removeJourney = useMeridianStore((s) => s.removeJourney);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);

  const [fetched, setFetched] = useState<Journey | null>(null);
  const [load, setLoad] = useState<Load>(stored ? "ready" : "loading");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  // Always fetch the single journey: it carries the freshest fingerprint.
  useEffect(() => {
    if (!unlocked) return;
    let live = true;
    getJourney(journeyId)
      .then((j) => {
        if (!live) return;
        if (!j) {
          removeJourney(journeyId);
          setLoad("missing");
          return;
        }
        setFetched(j);
        upsertJourney(j);
        setLoad("ready");
      })
      .catch((e) => {
        if (live && !(e instanceof JournalLockedError)) setLoad((l) => (l === "ready" ? l : "error"));
      });
    return () => {
      live = false;
    };
  }, [journeyId, tick, token, unlocked, upsertJourney, removeJourney]);

  const journey = stored ?? (fetched?.id === journeyId ? fetched : null);
  const pending = !!journey?.fingerprint && Object.values(journey.fingerprint.status).includes("pending");

  // A pending fingerprint is re-read every 20s, up to 3 times, while the page is open.
  useEffect(() => {
    if (!pending || !unlocked) return;
    let tries = 0;
    const id = window.setInterval(() => {
      tries++;
      getFingerprint(journeyId)
        .then(() => setTick((t) => t + 1))
        .catch(() => {});
      if (tries >= MAX_POLLS) window.clearInterval(id);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [pending, journeyId, unlocked]);

  if (!unlocked) {
    return (
      <>
        <PageHeader title="Trip" back={BACK} />
        <UnlockCard title="This trip is private" />
      </>
    );
  }

  if (!journey) {
    return (
      <>
        <PageHeader title={load === "missing" ? "Trip not found" : load === "error" ? "Trip" : <Skeleton width={220} height={28} />} back={BACK} />
        {load === "loading" ? (
          <div role="status" aria-busy="true" aria-label="Loading trip" className="trips-jd-skel">
            <Skeleton width={180} />
            {[0, 1, 2].map((i) => (
              <Card key={i}>
                <Skeleton lines={3} />
              </Card>
            ))}
          </div>
        ) : load === "missing" ? (
          <EmptyState
            size="page"
            icon={<IconCalendar />}
            title="This trip doesn't exist any more"
            action={
              <Button onClick={() => navigate({ view: "trips", tab: "past" })}>Back to past trips</Button>
            }
          />
        ) : (
          <ErrorState
            message="Couldn't load this trip."
            onRetry={() => {
              setLoad("loading");
              reload();
            }}
          />
        )}
      </>
    );
  }

  return <Detail key={journey.id} journey={journey} cityIdx={cityIdx} onReload={reload} onRemoved={() => removeJourney(journey.id)} />;
}

function Detail({
  journey: j,
  cityIdx,
  onReload,
  onRemoved,
}: {
  journey: Journey;
  cityIdx: ReturnType<typeof cityIndex>;
  onReload: () => void;
  onRemoved: () => void;
}) {
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const upsertJourney = useMeridianStore((s) => s.upsertJourney);
  const createTrip = useMeridianStore((s) => s.createTrip);
  const addCityToTrip = useMeridianStore((s) => s.addCityToTrip);

  const [stopIndex, setStopIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  const it = useMemo(() => itinerary(j), [j]);
  const segments = useMemo(() => [...it.legs.filter((g): g is NonNullable<typeof g> => !!g), ...it.other], [it]);
  const experiences = useMemo(() => [...j.experiences].sort((a, b) => a.date.localeCompare(b.date)), [j.experiences]);
  const nights = journeyNights(j);
  const selectedStop = stopIndex !== null ? j.stops[stopIndex] : undefined;

  const subtitle = [
    range(j.startDate, j.endDate),
    plural(nights, "night"),
    j.companions && j.companions > 1 ? plural(j.companions, "traveller") : "",
  ].filter(Boolean);

  const repeat = () =>
    navigate(`/plan/repeat/${encodeURIComponent(j.id)}${stopIndex !== null ? `/${stopIndex}` : ""}`);

  const watchSimilar = () => {
    setWatchPrefill({ journeyId: j.id, ...(stopIndex !== null ? { stopIndex } : {}) });
    navigate({ view: "plan", tab: "watches" });
  };

  const copyToPlan = () => {
    setMenuOpen(false);
    const tripId = createTrip(j.title);
    for (const s of j.stops) {
      const c = cityIdx.get(s.cityId);
      if (c) addCityToTrip(tripId, { cityId: c.id, name: c.name, iata: c.iata, lat: c.lat, lng: c.lng });
    }
    toast("Copied to a new plan");
    navigate({ view: "trips", tab: "upcoming", tripId });
  };

  const conflict = () => {
    toast("This trip was changed somewhere else. Showing the latest version.", { tone: "warning" });
    onReload();
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteJourney(j.id);
      setConfirmDelete(false);
      onRemoved();
      toast("Trip deleted");
      navigate({ view: "trips", tab: "past" });
    } catch (e) {
      setDeleting(false);
      if (e instanceof JournalApiError && e.status === 409) {
        setConfirmDelete(false);
        conflict();
      } else if (!(e instanceof JournalLockedError)) {
        toast("Couldn't delete this trip. Try again.", { tone: "danger" });
      }
    }
  };

  const confirmDraft = async () => {
    setConfirming(true);
    try {
      const input = { ...toJourneyInput(fromJourney(j), (id) => cityIdx.get(id)?.name ?? id), status: "confirmed" as const };
      upsertJourney(await saveJourney(input, j.id, j.updatedAt));
      toast("Trip confirmed", { tone: "success" });
    } catch (e) {
      if (e instanceof JournalApiError && e.status === 409) conflict();
      else if (!(e instanceof JournalLockedError))
        toast("Couldn't confirm this trip.", { tone: "danger", action: { label: "Retry", onClick: () => void confirmDraft() } });
    }
    setConfirming(false);
  };

  return (
    <article className="trips-jd">
      <PageHeader
        kicker="Past trip"
        title={j.title}
        subtitle={<span className="trips-jd-subtitle num">{subtitle.map((s, i) => <span key={i} className="trips-nowrap">{i > 0 ? ` · ${s}` : s}</span>)}</span>}
        back={BACK}
        actions={
          <>
            <Button icon={<IconEdit />} onClick={() => openQuickLog({ journeyId: j.id })}>
              Edit
            </Button>
            <IconButton
              ref={menuBtn}
              label="More actions"
              icon={<IconMore />}
              variant="secondary"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            />
            <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuBtn} placement="bottom-end" label="More actions" role="menu">
              <div className="trips-menu">
                <button type="button" role="menuitem" className="trips-menu-item" disabled={cityIdx.size === 0} onClick={copyToPlan}>
                  <IconTrips size={16} />
                  Copy to a new plan
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="trips-menu-item trips-menu-item--danger"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  <IconTrash size={16} />
                  Delete trip
                </button>
              </div>
            </Popover>
          </>
        }
      />

      {j.rating || j.tags.length ? (
        <div className="trips-jd-summary">
          <Stars value={j.rating} label="Trip rating" />
          {j.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      ) : null}

      {j.status === "draft" ? (
        <Card className="trips-jd-draft" role="status">
          <IconInfo size={20} />
          <p>This trip is a draft. Confirm it to count it in your totals and on the map.</p>
          <Button size="sm" loading={confirming} onClick={() => void confirmDraft()}>
            Confirm trip
          </Button>
        </Card>
      ) : null}

      <div className="trips-jd-grid">
        <div className="trips-jd-main">
          <section aria-labelledby="trips-jd-stops-title">
            <h2 id="trips-jd-stops-title" className="trips-jd-section-title">
              {plural(j.stops.length, "stop")}
            </h2>
            <ol className="trips-jd-stops">
              {j.stops.map((s, i) => (
                <StopCard
                  key={`${s.cityId}-${i}`}
                  stop={s}
                  index={i}
                  city={cityIdx.get(s.cityId)}
                  journeyFp={j.fingerprint}
                  selected={stopIndex === i}
                  onSelect={() => setStopIndex(stopIndex === i ? null : i)}
                />
              ))}
            </ol>
          </section>

          {segments.length > 0 ? (
            <Card padding="sm" className="trips-jd-collapse">
              <Disclosure summary={`Getting around (${segments.length})`}>
                <ul className="trips-jd-items">
                  {segments.map((g, i) => (
                    <SegmentItem key={i} seg={g} cities={cityIdx} />
                  ))}
                </ul>
              </Disclosure>
            </Card>
          ) : null}

          {experiences.length > 0 ? (
            <Card padding="sm" className="trips-jd-collapse">
              <Disclosure summary={`Things you did (${experiences.length})`}>
                <ul className="trips-jd-items">
                  {experiences.map((x, i) => (
                    <ExperienceItem key={i} x={x} cities={cityIdx} />
                  ))}
                </ul>
              </Disclosure>
            </Card>
          ) : null}

          {j.notes ? (
            <Card className="trips-jd-notes">
              <h2 className="trips-jd-card-title">Notes</h2>
              <p>{j.notes}</p>
            </Card>
          ) : null}
        </div>

        <aside className="trips-jd-side" aria-label="Trip profile">
          <FingerprintCard
            journey={j}
            stop={selectedStop}
            stopName={selectedStop ? cityIdx.get(selectedStop.cityId)?.name : undefined}
            fingerprint={selectedStop ? selectedStop.fingerprint : j.fingerprint}
            onClearStop={() => setStopIndex(null)}
          />
          <SpendCard journey={j} />
        </aside>
      </div>

      <footer className="trips-jd-footer">
        <p className="trips-jd-footer-hint">
          {selectedStop
            ? `Find places like ${cityIdx.get(selectedStop.cityId)?.name ?? "this stop"}, or watch prices for it.`
            : "Find places like this trip, or get told when similar trips get cheaper."}
        </p>
        <div className="trips-jd-footer-actions">
          <Button icon={<IconBell />} onClick={watchSimilar}>
            Watch similar
          </Button>
          <Button variant="primary" icon={<IconRefresh />} onClick={repeat}>
            Repeat this trip
          </Button>
        </div>
      </footer>

      <Dialog
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        role="alertdialog"
        title="Delete this trip?"
        description={`“${j.title}” and everything logged with it will be removed. This can't be undone.`}
        footer={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void remove()}>
              Delete trip
            </Button>
          </>
        }
      />
    </article>
  );
}
