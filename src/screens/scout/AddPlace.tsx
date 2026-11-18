import { useState } from "react";
import { Card, CitySearch, Field, Select, toast } from "../../ui";
import { JournalLockedError } from "../../lib/journalApi";
import { addToWishlist, type WishlistAddResult } from "../../lib/atlasApi";
import { PRIORITY_LABEL } from "../../lib/atlasFormat";
import type { City } from "../../types";

const PRIORITY_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}, ${PRIORITY_LABEL[n].toLowerCase()}` }));

/** Search the app's cities and add one to the wishlist as "yours". */
export function AddPlace({ existing, onAdded }: { existing: string[]; onAdded: () => void }) {
  const [priority, setPriority] = useState("3");
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState<WishlistAddResult["unresolved"]>([]);

  const add = async (city: City) => {
    setBusy(true);
    setUnresolved([]);
    try {
      const res = await addToWishlist([{ place: { cityId: city.id }, source: "wished", priority: Number(priority) }]);
      setUnresolved(res.unresolved);
      if (res.entries.length) {
        toast(`Added ${city.name} to your places`, { tone: "success" });
        onAdded();
      }
    } catch (err) {
      if (!(err instanceof JournalLockedError)) toast(`Could not add ${city.name}. ${err instanceof Error ? err.message : ""}`.trim(), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="sm" className="scout-add">
      <div className="scout-add-row">
        <Field label="Add a place" className="scout-add-search">
          <CitySearch placeholder="Search cities or airports" excludeIds={existing} disabled={busy} onPick={(c) => void add(c)} />
        </Field>
        <Field label="Priority" className="scout-add-priority">
          <Select options={PRIORITY_OPTIONS} value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>
      {unresolved.length > 0 && (
        <ul className="scout-error-list" role="alert">
          {unresolved.map((u, i) => (
            <li key={i}>Not added. {u.reason}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
