// Calendar and sharing for a trip (ADR 0010): download an .ics file, subscribe to a feed,
// and hand out a read-only link. The file is built in the browser. The feed and the
// shared page are served by the server, so they need the trip synced there (journal
// unlocked).

import { useCallback, useEffect, useState } from "react";
import { useMeridianStore } from "../../../store";
import { icsFileName, tripToIcs } from "../../../lib/ics";
import { hasItinerary } from "../../../lib/itinerary";
import { JournalLockedError } from "../../../lib/journalApi";
import type { TripRoute } from "../../../lib/legs";
import { createTripLink, fetchTripLinks, linkUrl, revokeTripLink, webcalUrl, type LinkKind, type TripLinks } from "../../../lib/tripLinksApi";
import { displayTripName } from "../../../lib/tripPlan";
import { Button, Dialog, toast, useJournalToken } from "../../../ui";
import { IconCalendar, IconCopy, IconExternal, IconLock, IconSend } from "../../../ui/icons";
import type { City, Trip } from "../../../types";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, { tone: "success" });
  } catch {
    toast("Couldn't copy. Select the link and copy it by hand.", { tone: "danger" });
  }
}

const COPY: Record<LinkKind, { title: string; help: string; make: string; what: string; offTitle: string; offBody: string }> = {
  page: {
    title: "Share link",
    help: "A read-only page of this trip: stops, dates, where you're staying and how you get around. No booking references, prices, notes or traveller details.",
    make: "Create share link",
    what: "Share link",
    offTitle: "Turn off the share link?",
    offBody: "Anyone who has the link will see a page saying it isn't available. You can create a new link later; it will be a different address.",
  },
  calendar: {
    title: "Calendar feed",
    help: "A private address your calendar app can subscribe to. It follows the trip as you change it. Booking references and prices are left out.",
    make: "Create calendar feed",
    what: "Feed address",
    offTitle: "Turn off the calendar feed?",
    offBody: "Calendars subscribed to it stop updating. You can create a new feed later; it will be a different address.",
  },
};

export function SharingCard({ trip, route, cityIdx }: { trip: Trip; route: TripRoute; cityIdx: Map<string, City> }) {
  const { unlocked } = useJournalToken();
  const home = useMeridianStore((s) => s.homeDeparture);
  const [links, setLinks] = useState<TripLinks | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState<LinkKind | null>(null);
  const [confirmOff, setConfirmOff] = useState<LinkKind | null>(null);
  const name = displayTripName(trip.name);
  const dated = !!trip.year && (hasItinerary(trip) || trip.nodes.some((n) => n.months));

  const load = useCallback(async () => {
    setState("loading");
    try {
      setLinks(await fetchTripLinks(trip.id));
      setState("idle");
    } catch (err) {
      setLinks(null);
      setState(err instanceof JournalLockedError ? "idle" : "error");
    }
  }, [trip.id]);

  useEffect(() => {
    if (unlocked) void load();
    else setLinks(null);
  }, [unlocked, load]);

  const download = () => {
    const ics = tripToIcs({ ...trip, name }, route, { zoneOf: (id) => cityIdx.get(id)?.timezone, includePrivate: true });
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = icsFileName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const make = async (kind: LinkKind) => {
    setBusy(kind);
    try {
      const link = await createTripLink(trip.id, kind, home);
      setLinks((l) => ({ page: null, calendar: null, ...l, [kind]: link }));
    } catch (err) {
      const notSynced = (err as { status?: number })?.status === 404;
      toast(notSynced ? "This trip hasn't reached the server yet. Give it a moment and try again." : "Couldn't create the link. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async (kind: LinkKind) => {
    setConfirmOff(null);
    setBusy(kind);
    try {
      await revokeTripLink(trip.id, kind);
      setLinks((l) => (l ? { ...l, [kind]: null } : l));
      toast(kind === "page" ? "Share link turned off" : "Calendar feed turned off");
    } catch {
      toast("Couldn't turn the link off. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const row = (kind: LinkKind) => {
    const c = COPY[kind];
    const link = links?.[kind] ?? null;
    const url = link ? linkUrl(kind, link.token, window.location.origin) : "";
    return (
      <div className="trips-share-block">
        <span className="trips-ed-label">{c.title}</span>
        <p className="trips-itin-help">{c.help}</p>
        {link ? (
          <>
            <input className="ui-input ui-input--sm trips-share-url" readOnly value={url} aria-label={c.what} onFocus={(e) => e.currentTarget.select()} />
            <div className="trips-share-actions">
              <Button size="sm" icon={<IconCopy size={14} />} onClick={() => void copy(url, c.what)}>
                Copy
              </Button>
              {kind === "page" ? (
                <a className="trips-ed-link" href={url} target="_blank" rel="noreferrer noopener">
                  Preview
                  <IconExternal size={12} />
                  <span className="sr-only"> the shared page (opens in a new tab)</span>
                </a>
              ) : (
                <a className="trips-ed-link" href={webcalUrl(url)}>
                  Subscribe
                  <IconExternal size={12} />
                  <span className="sr-only"> in your calendar app</span>
                </a>
              )}
              <Button size="sm" variant="ghost" loading={busy === kind} onClick={() => setConfirmOff(kind)}>
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <Button size="sm" icon={kind === "page" ? <IconSend size={14} /> : <IconCalendar size={14} />} loading={busy === kind} disabled={state === "loading"} onClick={() => void make(kind)}>
            {c.make}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="trips-share">
      <div className="trips-share-block">
        <span className="trips-ed-label">Calendar file</span>
        <p className="trips-itin-help">
          {dated
            ? "Stays as all-day spans, legs and activities at their times. This copy is yours, so it includes your booking references."
            : "Pick a year and add dates first: a season with no year has nothing to put in a calendar."}
        </p>
        <Button size="sm" icon={<IconCalendar size={14} />} disabled={!dated} onClick={download}>
          Download .ics
        </Button>
      </div>

      {unlocked ? (
        state === "error" ? (
          <div className="trips-share-block">
            <p className="trips-itin-help">Couldn't load this trip's links.</p>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {row("calendar")}
            {row("page")}
          </>
        )
      ) : (
        <div className="trips-share-block">
          <span className="trips-ed-label">Calendar feed and share link</span>
          <p className="trips-itin-help">
            <IconLock size={14} /> These are served from your Meridian server, so the trip has to be synced there. Unlock the journal in Settings, then come back.
          </p>
        </div>
      )}

      <Dialog
        open={confirmOff !== null}
        onClose={() => setConfirmOff(null)}
        role="alertdialog"
        title={confirmOff ? COPY[confirmOff].offTitle : ""}
        description={confirmOff ? COPY[confirmOff].offBody : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => confirmOff && void turnOff(confirmOff)}>
              Turn off
            </Button>
          </>
        }
      />
    </div>
  );
}
