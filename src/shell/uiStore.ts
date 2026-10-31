import { create } from "zustand";

// Cross-screen UI state that is not domain data (DESIGN-v3.md §2, §6).
// Domain state (trips, quick log, booking target, replay prefill…) stays in
// useMeridianStore; see CONTRACT.md for the field list.

export interface CityPanelState {
  cityId: string;
}

export interface AskState {
  open: boolean;
  /** Text to place in the input (not sent) when the panel opens. Ask clears it after use. */
  prefill?: string;
  /** Bumped on every openAsk so the panel can react to a repeat prefill. */
  nonce: number;
}

export interface UIState {
  /** Global city panel (rendered by the shell when set). */
  cityPanel: CityPanelState | null;
  openCity: (cityId: string) => void;
  closeCity: () => void;

  /** Ask (chat) panel: docked right column on desktop, sheet on phones. */
  ask: AskState;
  openAsk: (prefill?: string) => void;
  closeAsk: () => void;
  toggleAsk: () => void;
  /** Ask calls this after it has put the prefill into its input. */
  consumeAskPrefill: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  cityPanel: null,
  openCity: (cityId) => set({ cityPanel: { cityId } }),
  closeCity: () => set({ cityPanel: null }),

  ask: { open: false, nonce: 0 },
  openAsk: (prefill) => set((s) => ({ ask: { open: true, prefill, nonce: s.ask.nonce + 1 } })),
  closeAsk: () => set((s) => ({ ask: { ...s.ask, open: false, prefill: undefined } })),
  toggleAsk: () =>
    set((s) => (s.ask.open ? { ask: { ...s.ask, open: false, prefill: undefined } } : { ask: { open: true, nonce: s.ask.nonce + 1 } })),
  consumeAskPrefill: () => set((s) => ({ ask: { ...s.ask, prefill: undefined } })),
}));

/** Non-hook helpers for event handlers outside React. */
export const openCity = (cityId: string) => useUIStore.getState().openCity(cityId);
export const closeCity = () => useUIStore.getState().closeCity();
export const openAsk = (prefill?: string) => useUIStore.getState().openAsk(prefill);
export const closeAsk = () => useUIStore.getState().closeAsk();
export const toggleAsk = () => useUIStore.getState().toggleAsk();
