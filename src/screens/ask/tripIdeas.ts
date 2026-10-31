// Trip ideas from Ask: asks the agent for route options around a city and puts them in the shared
// store as agent candidates (useMeridianStore.trips with origin "agent"), where Trips › Upcoming and the
// map also show them. This store only tracks the request. Panel-local on purpose (not in uiStore).

import { create } from "zustand";
import { apiUrl } from "../../lib/api";
import { useMeridianStore } from "../../store";
import type { TripOption } from "../../types";

interface TripIdeasState {
  status: "idle" | "loading" | "error";
  cityId: string | null;
  cityName: string | null;
  request: (cityId: string, cityName: string) => Promise<void>;
}

let seq = 0;

export const useTripIdeas = create<TripIdeasState>((set) => ({
  status: "idle",
  cityId: null,
  cityName: null,
  request: async (cityId, cityName) => {
    const mine = ++seq;
    set({ status: "loading", cityId, cityName });
    try {
      const res = await fetch(apiUrl("/api/agent/trip-options"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cityId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { options?: TripOption[] };
      if (mine !== seq) return;
      useMeridianStore.getState().setAgentCandidates(data.options ?? []);
      set({ status: "idle" });
    } catch {
      if (mine === seq) set({ status: "error" });
    }
  },
}));

/** Remove one suggestion. */
export function dismissIdea(tripId: string) {
  useMeridianStore.getState().discardCandidate(tripId);
}
