/**
 * GA4 behind Consent Mode v2.
 *
 * Order matters, so all of it runs from main.tsx before React renders:
 *   1. the dataLayer and gtag() stub exist,
 *   2. consent defaults go in as denied (nothing is stored before a choice),
 *   3. a choice saved on an earlier visit is replayed as an update,
 *   4. only then does gtag.js load and the property get configured.
 * If gtag.js loaded before step 2, its first hits would carry no consent
 * state and GA would treat them as granted.
 *
 * Nothing loads without VITE_GA_ID, so local dev and builds without the
 * variable stay silent. Nothing loads inside a frame either: the owner's
 * portfolio embeds the app as an inert preview, and counting that would
 * fill the reports with visits nobody made.
 *
 * Routing is hash based (#/trips, #/plan/when). GA reports drop the hash,
 * so page views go out by hand with the route as a virtual path
 * (/trips, /plan/when). The web stream's "page changes based on browser
 * history events" should be off so nothing is counted twice.
 *
 * The Content-Security-Policy only lets gtag.js and its hits through when the
 * build has VITE_GA_ID (server/lib/securityHeaders.ts, `analytics`).
 */
const RAW_ID = import.meta.env.VITE_GA_ID?.trim();
/** Only a GA4 measurement ID counts; the server's CSP applies the same test (analyticsConfigured). */
export const GA_ID: string | undefined = RAW_ID && /^G-[A-Z0-9]+$/.test(RAW_ID) ? RAW_ID : undefined;

const CONSENT_KEY = "meridian.consent";
/** Ask again after a year, as most EU guidance expects. */
const CONSENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type ConsentChoice = "granted" | "denied";

type GtagArgs = [string, ...unknown[]];

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: GtagArgs) => void;
  }
}

let started = false;
const listeners = new Set<() => void>();

function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access: that is a frame too.
    return true;
  }
}

/** True when this page load can send anything to GA at all. */
export function analyticsEnabled(): boolean {
  return Boolean(GA_ID) && typeof window !== "undefined" && !framed();
}

function gtag(..._args: GtagArgs) {
  if (!started) return;
  // gtag.js reads the `arguments` object, not an array, from the dataLayer.
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments);
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

export function readConsent(): ConsentChoice | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { choice?: ConsentChoice; at?: number };
    if (saved.choice !== "granted" && saved.choice !== "denied") return null;
    if (!saved.at || Date.now() - saved.at > CONSENT_TTL_MS) return null;
    return saved.choice;
  } catch {
    return null;
  }
}

/**
 * The banner offers analytics only. The app runs no ads, so the three ad
 * signals stay denied whatever the visitor picks.
 */
function consentState(choice: ConsentChoice) {
  return {
    analytics_storage: choice,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

export function initAnalytics() {
  if (started || !analyticsEnabled()) return;
  started = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;

  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    // Gives the banner's update a moment to land before the first hit when
    // a choice is replayed or made straight away.
    wait_for_update: 500,
  });
  // Strip ad click identifiers from the cookieless pings sent while denied.
  gtag("set", "ads_data_redaction", true);

  const saved = readConsent();
  if (saved) gtag("consent", "update", consentState(saved));

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID!)}`;
  document.head.appendChild(script);

  gtag("js", new Date());
  gtag("config", GA_ID, { send_page_view: false });
}

export function setConsent(choice: ConsentChoice) {
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice, at: Date.now() }));
  } catch {
    // Private mode: the choice holds for this visit only.
  }
  gtag("consent", "update", consentState(choice));
  for (const cb of listeners) cb();
}

/** Called when the saved choice changes, or when Settings asks for the banner again. */
export function onConsentChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let askAgain = false;
/** Settings > Privacy: show the banner again so the visitor can change the answer. */
export function reopenConsent() {
  askAgain = true;
  for (const cb of listeners) cb();
}
/** The banner reads this once it is open, then clears it. */
export function takeAskAgain(): boolean {
  const v = askAgain;
  askAgain = false;
  return v;
}

/** A route path such as "/trips/past" as a page view on a real URL. */
export function trackPageView(path: string, title?: string) {
  gtag("event", "page_view", {
    page_location: window.location.origin + path,
    page_path: path,
    ...(title ? { page_title: title } : {}),
  });
}

/**
 * Event names and parameters are listed in docs/analytics.md. Never send
 * free text a visitor typed beyond a city search term, and nothing personal.
 */
export function trackEvent(name: string, params: Record<string, string | number | boolean | undefined> = {}) {
  gtag("event", name, params);
}
