const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Cookie policy for API calls. The session cookie rides along on its own when the API
 * is this origin; with VITE_API_BASE_URL pointing elsewhere it has to be asked for.
 */
export const apiCredentials: RequestCredentials = apiBaseUrl ? "include" : "same-origin";
