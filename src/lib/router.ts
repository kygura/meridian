import { useSyncExternalStore } from "react";

export type Route =
  | { view: "globe" }
  | { view: "trips"; tripId?: string }
  | { view: "seasons" }
  | {
      view: "journal";
      sub: "timeline" | "detail" | "inbox" | "replay";
      journeyId?: string;
      stopIndex?: number;
    };

const seg = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/seasons") return { view: "seasons" };
  const m = path.match(/^\/trips(?:\/([^/]+))?$/);
  if (m) return { view: "trips", tripId: m[1] };
  // Order matters: keywords before /journal/:id so ":id" cannot swallow them.
  if (/^\/journal\/?$/.test(path)) return { view: "journal", sub: "timeline" };
  if (/^\/journal\/inbox\/?$/.test(path)) return { view: "journal", sub: "inbox" };
  const r = path.match(/^\/journal\/replay(?:\/([^/]+)(?:\/(\d+))?)?\/?$/);
  if (r) {
    return {
      view: "journal",
      sub: "replay",
      journeyId: r[1] ? seg(r[1]) : undefined,
      stopIndex: r[2] !== undefined ? Number(r[2]) : undefined,
    };
  }
  const d = path.match(/^\/journal\/([^/]+)\/?$/);
  if (d) return { view: "journal", sub: "detail", journeyId: seg(d[1]) };
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
