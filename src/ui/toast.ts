import { create } from "zustand";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms; 0 keeps it until dismissed. */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Show a short message. `toast("Trip saved")`, `toast("Couldn't save", { tone: "danger" })`. */
export function toast(
  message: string,
  opts: { tone?: ToastTone; action?: ToastItem["action"]; duration?: number } = {}
): number {
  return useToastStore.getState().push({
    message,
    tone: opts.tone ?? "neutral",
    action: opts.action,
    duration: opts.duration ?? (opts.action ? 8000 : 4000),
  });
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismiss(id);
}
