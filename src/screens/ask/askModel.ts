import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiUrl } from "../../lib/api";

// The Claude model the Ask panel talks to (GET /api/agent/models), remembered per browser.

export interface AskModel {
  id: string;
  label: string;
  note: string;
}

interface AskModelState {
  /** null = the server's default. */
  model: string | null;
  setModel: (id: string | null) => void;
}

export const useAskModel = create<AskModelState>()(
  persist((set) => ({ model: null, setModel: (model) => set({ model }) }), { name: "meridian.ask-model" })
);

interface ModelList {
  models: AskModel[];
  default: string;
  /** false when the server has no Anthropic key (Ask runs its demo path). */
  available: boolean;
}

let cached: ModelList | null = null;
let inflight: Promise<ModelList | null> | null = null;

function loadModels(): Promise<ModelList | null> {
  inflight ??= fetch(apiUrl("/api/agent/models"))
    .then((r) => (r.ok ? r.json() : null))
    .then((b: Partial<ModelList> | null) => {
      if (!b || !Array.isArray(b.models) || typeof b.default !== "string") return null;
      cached = { models: b.models, default: b.default, available: b.available === true };
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The selectable models and the one in use (a stored choice the server no longer offers falls back to its default). */
export function useAskModels(): { list: ModelList | null; selected: string | null } {
  const [list, setList] = useState<ModelList | null>(cached);
  const stored = useAskModel((s) => s.model);
  useEffect(() => {
    if (!cached) void loadModels().then((l) => l && setList(l));
  }, []);
  const selected = list ? (stored && list.models.some((m) => m.id === stored) ? stored : list.default) : stored;
  return { list, selected };
}
