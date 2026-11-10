// The visa data and settings for screens (ADR 0012): fetched once per sign-in from
// /api/visa/data (only the owner's passports' rows) and shared by every screen that checks
// stays. Settings › Visas calls `refreshVisa()` after saving.

import { useEffect, useSyncExternalStore } from "react";
import { getVisaData } from "./visaApi";
import { useJournalToken } from "../ui/journalToken";
import type { VisaData } from "./visa/data";
import type { VisaSettings } from "./visa/settings";

export interface VisaState {
  status: "idle" | "loading" | "ready" | "error";
  data: VisaData | null;
  settings: VisaSettings | null;
  error?: string;
}

let state: VisaState = { status: "idle", data: null, settings: null };
const subs = new Set<() => void>();
const emit = (s: VisaState) => {
  state = s;
  for (const f of subs) f();
};

let inflight: Promise<void> | null = null;
export function refreshVisa(): Promise<void> {
  inflight ??= getVisaData()
    .then((r) => emit({ status: "ready", data: r.data, settings: r.settings }))
    .catch((e: unknown) => emit({ status: "error", data: null, settings: null, error: e instanceof Error ? e.message : "Couldn't load the visa data" }))
    .finally(() => {
      inflight = null;
    });
  if (state.status === "idle") emit({ ...state, status: "loading" });
  return inflight;
}

export function resetVisa(): void {
  emit({ status: "idle", data: null, settings: null });
}

/** Visa data and settings, loaded on first use while signed in. */
export function useVisa(): VisaState & { passports: string[]; unlocked: boolean } {
  const { unlocked, token } = useJournalToken();
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state
  );
  useEffect(() => {
    if (!unlocked) {
      if (state.status !== "idle") resetVisa();
      return;
    }
    if (state.status === "idle") void refreshVisa();
  }, [unlocked, token]);
  return { ...s, passports: (s.settings?.passports ?? []).map((p) => p.country), unlocked };
}
