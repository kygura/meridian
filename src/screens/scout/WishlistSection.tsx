import { useState } from "react";
import { Badge, Button, Dialog, EmptyState, IconButton, Select, SectionHeader, cx, toast } from "../../ui";
import { IconPin, IconTrash } from "../../ui/icons";
import { openCity } from "../../shell/uiStore";
import { JournalLockedError } from "../../lib/journalApi";
import { patchWishlistPlace, removeWishlistPlace, type AtlasContext, type WishlistPatch, type WishlistPlace } from "../../lib/atlasApi";
import { PRIORITY_LABEL } from "../../lib/atlasFormat";
import type { Resource } from "./useScout";
import { MonthStrip, StripLegend } from "./MonthStrip";
import { WatchControl } from "./WatchControl";
import { AddPlace } from "./AddPlace";

const PRIORITY_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}, ${PRIORITY_LABEL[n].toLowerCase()}` }));

export const failMessage = (err: unknown): string => (err instanceof Error ? err.message : "The request failed.");

interface Props {
  context: Resource<AtlasContext>;
  places: WishlistPlace[];
  nowMonth: number;
}

/** The owner's places to go, with comfort by month, research marks, priority and watch. */
export function WishlistSection({ context, places, nowMonth }: Props) {
  const [toRemove, setToRemove] = useState<WishlistPlace | null>(null);
  const [removing, setRemoving] = useState(false);

  /** Apply a server-confirmed change to one place without losing its season data. */
  const merge = (cityId: string, entry: Partial<WishlistPlace>) =>
    context.set((prev) => (prev ? { ...prev, wishlist: prev.wishlist.map((p) => (p.cityId === cityId ? { ...p, ...entry, season: p.season } : p)) } : prev));

  /** PATCH a place. Returns true when saved; a failure toasts and leaves the row as it was. */
  const patch = async (place: WishlistPlace, body: WishlistPatch): Promise<boolean> => {
    try {
      const entry = await patchWishlistPlace(place.cityId, body);
      merge(place.cityId, entry);
      // Priority changes the ideas ranking; reread quietly.
      if (body.priority !== undefined) void context.reload(true);
      return true;
    } catch (err) {
      if (!(err instanceof JournalLockedError)) toast(`Could not save ${place.name}. ${failMessage(err)}`, { tone: "danger" });
      return false;
    }
  };

  const confirmRemove = async () => {
    if (!toRemove) return;
    setRemoving(true);
    try {
      await removeWishlistPlace(toRemove.cityId);
      toast(`Removed ${toRemove.name} from your places`);
      setToRemove(null);
      void context.reload(true);
    } catch (err) {
      if (!(err instanceof JournalLockedError)) toast(`Could not remove ${toRemove.name}. ${failMessage(err)}`, { tone: "danger" });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="scout-section" aria-labelledby="scout-wishlist">
      <SectionHeader id="scout-wishlist" title="Your places" meta={places.length ? `${places.length} on the wishlist` : undefined} />
      <p className="scout-lede">
        Places you want to go. Atlas checks them each run and never removes one on its own. Places it finds itself are marked as scouted.
      </p>
      <AddPlace existing={places.map((p) => p.cityId)} onAdded={() => void context.reload(true)} />

      {places.length === 0 ? (
        <EmptyState
          icon={<IconPin />}
          title="No places yet"
          description="Add a city above. Atlas ranks your places for each search window, watches fares for the ones you choose, and adds places it scouts itself."
        />
      ) : (
        <>
          <StripLegend />
          <ul className="scout-list">
            {places.map((p) => (
              <li key={p.cityId}>
                <article className={cx("scout-place", p.season.avoidNow && "is-avoid-now")} aria-label={p.spot?.name ?? p.name}>
                  <div className="scout-place-info">
                    <div className="scout-place-title">
                      <button type="button" className="scout-link" onClick={() => openCity(p.cityId)}>
                        {p.spot?.name ?? p.name}
                      </button>
                      {p.iata && <span className="iata">{p.iata}</span>}
                    </div>
                    <p className="scout-muted scout-place-country">{p.spot ? `Via ${p.name}, ${p.country}` : p.country}</p>
                    <div className="scout-place-badges">
                      <Badge tone={p.source === "wished" ? "accent" : "neutral"}>{p.source === "wished" ? "yours" : "scouted"}</Badge>
                      {p.season.avoidNow && <Badge tone="warning">Avoid now</Badge>}
                      {p.watch?.active && <Badge tone="success">Watching</Badge>}
                    </div>
                    <label className="scout-priority">
                      <span className="scout-label">Priority</span>
                      <Select
                        size="sm"
                        aria-label={`Priority for ${p.name}`}
                        value={String(p.priority)}
                        options={PRIORITY_OPTIONS}
                        onChange={(e) => void patch(p, { priority: Number(e.target.value) })}
                      />
                    </label>
                    <WatchControl place={p} onSave={(watch) => patch(p, { watch })} />
                    {p.notes && <p className="scout-notes">{p.notes}</p>}
                    {p.intentTags.length > 0 && <p className="scout-muted scout-tags">{p.intentTags.join(", ")}</p>}
                  </div>
                  <div className="scout-place-season">
                    <MonthStrip place={p} nowMonth={nowMonth} />
                    {p.season.year == null && <p className="scout-muted">No climate data for this place yet.</p>}
                  </div>
                  <div className="scout-place-actions">
                    <IconButton label={`Remove ${p.name} from your places`} icon={<IconTrash size={18} />} variant="ghost" onClick={() => setToRemove(p)} />
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        role="alertdialog"
        title={toRemove ? `Remove ${toRemove.name}?` : "Remove place"}
        description="Atlas never removes your places on its own. This removes the place and any watch on it from the wishlist. Fare history stays."
        footer={
          <>
            <Button onClick={() => setToRemove(null)} data-autofocus>
              Keep
            </Button>
            <Button variant="danger" loading={removing} onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </>
        }
      />
    </section>
  );
}
