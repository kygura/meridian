import { create } from "zustand";
import { toast } from "../../ui";
import { JournalLockedError } from "../../lib/journalApi";
import {
  getRotation,
  removePlace,
  removeStay,
  RotationConflictError,
  savePlace,
  saveSettings,
  saveStay,
  type RotationSnapshot,
} from "../../lib/rotationApi";
import { DEFAULT_SETTINGS, todayIso, type PlaceProfile, type RotationSettings, type RotationStay } from "../../lib/rotation";

// The rotation lives on the server only (ADR 0011): this screen reads it on open and on
// window focus, and writes one stay or place at a time with the copy it was edited from.
// When another browser saved first, the server refuses and the screen reloads.

interface RotationStore {
  data: RotationSnapshot | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  putStay: (stay: RotationStay) => Promise<boolean>;
  putStays: (stays: RotationStay[]) => Promise<number>;
  deleteStay: (id: string) => Promise<void>;
  putPlace: (place: PlaceProfile) => Promise<boolean>;
  deletePlace: (cityId: string) => Promise<void>;
  putSettings: (settings: RotationSettings) => Promise<boolean>;
}

function onWriteError(err: unknown, reload: () => Promise<void>): void {
  if (err instanceof RotationConflictError) {
    toast(err.kind === "deleted" ? "That was deleted in another browser." : "That changed in another browser. Showing the latest; make your edit again.", { tone: "warning" });
    void reload();
    return;
  }
  if (err instanceof JournalLockedError) {
    toast("Sign in again to save.", { tone: "danger" });
    return;
  }
  toast("Couldn't save. Check your connection and try again.", { tone: "danger" });
}

export const useRotation = create<RotationStore>((set, get) => {
  const patch = (fn: (d: RotationSnapshot) => RotationSnapshot) => {
    const d = get().data;
    if (d) set({ data: fn(d) });
  };
  return {
    data: null,
    loading: false,
    error: null,
    async load() {
      set({ loading: true });
      try {
        const data = await getRotation(todayIso());
        set({ data: { ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings } }, loading: false, error: null });
      } catch (err) {
        set({ loading: false, error: err instanceof JournalLockedError ? null : "Couldn't load your rotation." });
      }
    },
    async putStay(stay) {
      const before = get().data?.stays.find((s) => s.id === stay.id);
      try {
        const saved = await saveStay(stay, before?.updatedAt);
        patch((d) => ({ ...d, stays: before ? d.stays.map((s) => (s.id === saved.id ? saved : s)) : [...d.stays, saved] }));
        return true;
      } catch (err) {
        onWriteError(err, get().load);
        return false;
      }
    },
    async putStays(stays) {
      let ok = 0;
      for (const s of stays) if (await get().putStay(s)) ok++;
      return ok;
    },
    async deleteStay(id) {
      try {
        await removeStay(id);
        patch((d) => ({ ...d, stays: d.stays.filter((s) => s.id !== id) }));
      } catch (err) {
        onWriteError(err, get().load);
      }
    },
    async putPlace(place) {
      const before = get().data?.places.find((p) => p.cityId === place.cityId);
      try {
        const saved = await savePlace(place, before?.updatedAt);
        patch((d) => ({ ...d, places: before ? d.places.map((p) => (p.cityId === saved.cityId ? saved : p)) : [...d.places, saved] }));
        return true;
      } catch (err) {
        onWriteError(err, get().load);
        return false;
      }
    },
    async deletePlace(cityId) {
      try {
        await removePlace(cityId);
        patch((d) => ({ ...d, places: d.places.filter((p) => p.cityId !== cityId) }));
      } catch (err) {
        onWriteError(err, get().load);
      }
    },
    async putSettings(settings) {
      try {
        const saved = await saveSettings(settings, get().data?.settings.updatedAt);
        patch((d) => ({ ...d, settings: saved }));
        return true;
      } catch (err) {
        onWriteError(err, get().load);
        return false;
      }
    },
  };
});
