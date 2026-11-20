/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** GA4 measurement ID (G-...). Unset: no analytics, no banner (src/lib/analytics.ts). */
  readonly VITE_GA_ID?: string;
}
