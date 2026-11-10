// Security headers (ADR 0009), built in one place and sent from both deployments:
// the Hono app adds them to every response it serves (server/middleware/guards.ts),
// and scripts/build-vercel.mjs writes the same set onto Vercel's static routes.
//
// The Content-Security-Policy lists exactly what the frontend loads:
//   scripts   own files only (the theme bootstrap is /theme-init.js, not inline)
//   styles    own files, inline style attributes (React, MapLibre)
//   fonts     own files (self-hosted, ADR 0016)
//   images    own files, data:/blob: (MapLibre sprites, photo previews), Wikimedia photos in Ask
//   connect   the API, and the Natural Earth country outlines the map fetches
//   workers   blob: (MapLibre builds its worker from a blob URL)
// The basemap has no tile host: land comes from that one GeoJSON and labels use glyphs
// served from /fonts.

/** Hosts the map fetches data from (src/screens/map/countries.ts). */
export const MAP_DATA_HOSTS = ["https://d2ad6b4ur7yvpq.cloudfront.net"] as const;
/** Photo hosts for places shown in Ask (server/lib/agent/tools.ts returns Wikimedia URLs). */
export const IMAGE_HOSTS = ["https://upload.wikimedia.org", "https://commons.wikimedia.org"] as const;

export interface SecurityHeaderOptions {
  /** Adds Strict-Transport-Security. */
  production?: boolean;
  /** Origin of the API when the frontend is built with VITE_API_BASE_URL pointing elsewhere. */
  apiOrigin?: string | null;
}

/** "https://api.example.com/x" → "https://api.example.com"; anything unparsable → null. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(opts: SecurityHeaderOptions = {}): string {
  const connect = ["'self'", "data:", "blob:", ...MAP_DATA_HOSTS, ...(opts.apiOrigin ? [opts.apiOrigin] : [])];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["font-src", ["'self'", "data:"]],
    ["img-src", ["'self'", "data:", "blob:", ...IMAGE_HOSTS]],
    ["connect-src", connect],
    ["worker-src", ["'self'", "blob:"]],
    ["child-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

export function securityHeaders(opts: SecurityHeaderOptions = {}): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(opts),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Older browsers that ignore frame-ancestors.
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(opts.production ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}
