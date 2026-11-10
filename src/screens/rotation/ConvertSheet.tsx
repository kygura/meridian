import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Segmented, Sheet, Spinner } from "../../ui";
import { useMeridianStore } from "../../store";
import { refreshJourneys } from "../../lib/journalApi";
import { cityIndex, formatRange } from "../../lib/journal";
import { seasonText } from "../../lib/season";
import { journeyStayTemplate, tripToRotation, todayIso, type RotationPlace, type RotationStay } from "../../lib/rotation";

export interface ConvertSheetProps {
  open: boolean;
  onClose: () => void;
  /** Add the stays a trip becomes; returns how many were saved. */
  onTrip: (stays: RotationStay[], home?: RotationPlace) => Promise<void>;
  /** Open a new stay prefilled from a past stop. */
  onTemplate: (template: RotationStay) => void;
}

/** Turn a Trip into rotation stays, or a stop from a past Journey into a stay template. */
export function ConvertSheet({ open, onClose, onTrip, onTemplate }: ConvertSheetProps) {
  const [tab, setTab] = useState<"trip" | "journey">("trip");
  const trips = useMeridianStore((s) => s.trips);
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys);
  const [busy, setBusy] = useState<string | null>(null);
  const index = useMemo(() => cityIndex(cities), [cities]);
  const userTrips = trips.filter((t) => t.origin !== "agent" && t.nodes.length > 0);

  useEffect(() => {
    if (open && tab === "journey" && journeys === null) refreshJourneys().catch(() => {});
  }, [open, tab, journeys]);

  const today = todayIso();

  return (
    <Sheet open={open} onClose={onClose} title="Add from your plans" description="A trip becomes stays; a past stop becomes a template you place yourself.">
      <div className="rotation-form">
        <Segmented<"trip" | "journey">
          label="Source"
          value={tab}
          onChange={setTab}
          block
          options={[
            { value: "trip", label: "From a trip" },
            { value: "journey", label: "From a past journey" },
          ]}
        />
        {tab === "trip" ? (
          userTrips.length === 0 ? (
            <EmptyState size="inline" title="No trips with stops yet" description="Plan one under Trips, then bring it here." />
          ) : (
            <ul className="rotation-pick-list">
              {userTrips.map((t) => {
                const preview = tripToRotation(t, today, (id) => index.get(id), () => "preview");
                return (
                  <li key={t.id} className="rotation-pick">
                    <div>
                      <div className="rotation-pick-title">{t.name || "Untitled trip"}</div>
                      <div className="rotation-muted rotation-fine">
                        {t.nodes.map((n) => n.name).join(" → ")}
                        {seasonText(t) ? ` · ${seasonText(t)}` : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      loading={busy === t.id}
                      onClick={async () => {
                        setBusy(t.id);
                        const { stays, home } = tripToRotation(t, today, (id) => index.get(id));
                        await onTrip(stays, home);
                        setBusy(null);
                      }}
                    >
                      Add {preview.stays.length} {preview.stays.length === 1 ? "stay" : "stays"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        ) : journeys === null ? (
          <Spinner label="Loading your journal" />
        ) : journeys.length === 0 ? (
          <EmptyState size="inline" title="No past journeys yet" description="Log a trip and its stops show up here." />
        ) : (
          <ul className="rotation-pick-list">
            {journeys.flatMap((j) =>
              j.stops.map((s, i) => {
                const city = index.get(s.cityId);
                return (
                  <li key={`${j.id}:${i}`} className="rotation-pick">
                    <div>
                      <div className="rotation-pick-title">{city?.name ?? s.cityId}</div>
                      <div className="rotation-muted rotation-fine">
                        {j.title} · {formatRange(s.arrive, s.depart)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={!city}
                      onClick={() => {
                        const t = journeyStayTemplate(j, i, (id) => index.get(id));
                        if (t) onTemplate(t);
                      }}
                    >
                      Use as template
                    </Button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
