// Screen-local store for agent trip suggestions (ported from components/TripCandidates).
// Candidates themselves live in useMeridianStore.trips (origin "agent"); this store only
// tracks the request: which city they came from, loading and error.

import { create } from "zustand";
import { apiCredentials, apiUrl } from "../../../lib/api";
import { useMeridianStore } from "../../../store";
import type { TripOption } from "../../../types";

type Status = "idle" | "loading" | "error";

interface SuggestState {
  status: Status;
  /** City the current suggestions were generated from. */
  sourceCityId: string | null;
  request: (cityId: string) => Promise<void>;
}

let seq = 0;

export const useSuggestStore = create<SuggestState>((set) => ({
  status: "idle",
  sourceCityId: null,
  request: async (cityId) => {
    const mine = ++seq;
    set({ status: "loading", sourceCityId: cityId });
    try {
      const res = await fetch(apiUrl("/api/agent/trip-options"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: apiCredentials,
        body: JSON.stringify({ cityId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { options?: TripOption[] };
      if (mine !== seq) return;
      useMeridianStore.getState().setAgentCandidates(data.options ?? []);
      set({ status: "idle" });
    } catch {
      if (mine !== seq) return;
      set({ status: "error" });
    }
  },
}));

/** Remove one suggestion. */
export function dismissCandidate(tripId: string) {
  useMeridianStore.getState().discardCandidate(tripId);
}
