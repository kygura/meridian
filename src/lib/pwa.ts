// The page's side of offline use (ADR 0016): registers the service worker, offers a
// reload when a new version has installed, tracks connectivity for the offline
// indicator, and empties the private cache when the journal is locked.
//
// The service worker exists only in a production build (`npm run build`); under
// `vite dev` everything here is a no-op and the app talks straight to the network.

import { create } from "zustand";

/** Must match PRIVATE in src/sw/sw.ts. */
export const PRIVATE_CACHE = "meridian-private-v1";

interface ConnectivityState {
  /** navigator.onLine. */
  browserOnline: boolean;
  /** False once the service worker saw an API request fail; true again when one succeeds. */
  apiReachable: boolean;
  /** A new version is installed and waiting for a reload. */
  updateReady: boolean;
}

export const useConnectivity = create<ConnectivityState>(() => ({
  browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
  apiReachable: true,
  updateReady: false,
}));

/** True when the app is showing saved data: the browser is offline or the API can't be reached. */
export function isOffline(s: Pick<ConnectivityState, "browserOnline" | "apiReachable">): boolean {
  return !s.browserOnline || !s.apiReachable;
}

export function useOffline(): boolean {
  return useConnectivity(isOffline);
}

/**
 * Forget every personal answer the service worker kept (trips, journal, bookings,
 * watches, notices). Call whenever the journal is locked or the token is cleared, so
 * the next person at this device finds nothing. Works without a service worker too.
 */
export async function purgePrivateCache(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(PRIVATE_CACHE);
  } catch {
    /* Cache API unavailable (private window): nothing was kept */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "purge-private" });
  } catch {
    /* no worker */
  }
}

let waiting: ServiceWorker | null = null;

/** Activate the waiting version; the page reloads when it takes over. */
export function applyUpdate(): void {
  if (waiting) waiting.postMessage({ type: "skip-waiting" });
  else window.location.reload();
}

export interface PwaOptions {
  /** Called once when a new version is ready (show the reload prompt). */
  onUpdateReady: () => void;
  /** Called when this page first comes under a service worker: a good moment to fetch the data worth keeping. */
  onFirstControl?: () => void;
  /** Called when a notification was clicked while the app was open. */
  onNavigate?: (url: string) => void;
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Call once at startup. Returns a stop function. */
export function startPwa(opts: PwaOptions): () => void {
  const setOnline = () => {
    const browserOnline = navigator.onLine;
    // Coming back online: assume the API is reachable until a request says otherwise.
    useConnectivity.setState(browserOnline ? { browserOnline, apiReachable: true } : { browserOnline });
  };
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
  const stopNet = () => {
    window.removeEventListener("online", setOnline);
    window.removeEventListener("offline", setOnline);
  };

  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return stopNet;
  const sw = navigator.serviceWorker;
  let stopped = false;
  let announced = false;
  const hadController = !!sw.controller;
  let reloading = false;

  const ready = (worker: ServiceWorker | null) => {
    if (!worker || announced || stopped) return;
    waiting = worker;
    announced = true;
    useConnectivity.setState({ updateReady: true });
    opts.onUpdateReady();
  };

  const onControllerChange = () => {
    if (!hadController) return opts.onFirstControl?.(); // first install: nothing to reload
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; ok?: boolean; url?: string } | null;
    if (data?.type === "net" && typeof data.ok === "boolean") useConnectivity.setState({ apiReachable: data.ok });
    if (data?.type === "navigate" && typeof data.url === "string") opts.onNavigate?.(data.url);
  };
  sw.addEventListener("controllerchange", onControllerChange);
  sw.addEventListener("message", onMessage);

  let registration: ServiceWorkerRegistration | undefined;
  const check = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void registration?.update().catch(() => undefined);
  };
  const timer = window.setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener("visibilitychange", check);

  sw.register("/sw.js", { scope: "/" })
    .then((reg) => {
      registration = reg;
      // Installed while this tab was closed.
      if (reg.waiting && sw.controller) ready(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed" && sw.controller) ready(next);
        });
      });
    })
    .catch((err) => console.warn("[pwa] service worker not registered:", err));

  return () => {
    stopped = true;
    stopNet();
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", check);
    sw.removeEventListener("controllerchange", onControllerChange);
    sw.removeEventListener("message", onMessage);
  };
}
