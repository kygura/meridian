// A search-results link for a fare whose connector gave no booking link (Expedia's connector
// returns none). The link opens the same route and dates on the source site, so the traveller
// lands on the fare list rather than a dead end. It is a search page, not a held fare.

export interface SearchLinkInput {
  source: string;
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD
}

/** Expedia's date format in its search URL: M/D/YYYY. */
function expediaDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

export function searchLinkFor(f: SearchLinkInput): string {
  const from = f.origin.toUpperCase();
  const to = f.destination.toUpperCase();
  if (f.source.toLowerCase().includes("expedia")) {
    const params = [
      "trip=roundtrip",
      `leg1=from:${from},to:${to},departure:${expediaDate(f.departDate)}TANYT`,
      `leg2=from:${to},to:${from},departure:${expediaDate(f.returnDate)}TANYT`,
      "passengers=adults:1",
      "options=cabinclass:economy",
      "mode=search",
    ];
    return `https://www.expedia.com/Flights-Search?${params.join("&")}`;
  }
  // Any other source: Google Flights reads a plain-language query and opens the same search.
  const q = `Flights from ${from} to ${to} on ${f.departDate} through ${f.returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}
