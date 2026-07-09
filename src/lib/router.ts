import { useSyncExternalStore } from "react";

export type Route =
  | { view: "globe" }
  | { view: "trips"; tripId?: string }
  | { view: "seasons" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/seasons") return { view: "seasons" };
  const m = path.match(/^\/trips(?:\/([^/]+))?$/);
  if (m) return { view: "trips", tripId: m[1] };
  return { view: "globe" };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(path: string): void {
  window.location.hash = path === "/" ? "" : path;
}
