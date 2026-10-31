// Country name helpers shared by the map and the World screen. Pure: no React, no fetch.
//
// City records use worldcities.csv spellings ("Korea, South", "Burma", "Bosnia And
// Herzegovina"). Natural Earth polygons and news labels use others. countryKey() folds
// every spelling of the same country onto one lowercase key so they can be joined.

const ALIASES: Record<string, string> = {
  "bahamas, the": "bahamas",
  "the bahamas": "bahamas",
  "gambia, the": "gambia",
  "the gambia": "gambia",
  "korea, south": "south korea",
  "republic of korea": "south korea",
  korea: "south korea",
  "korea, north": "north korea",
  "dem. rep. korea": "north korea",
  burma: "myanmar",
  "congo (brazzaville)": "republic of congo",
  "republic of the congo": "republic of congo",
  congo: "republic of congo",
  "congo (kinshasa)": "democratic republic of the congo",
  "dem. rep. congo": "democratic republic of the congo",
  czechia: "czech republic",
  "czech rep.": "czech republic",
  "cote d'ivoire": "ivory coast",
  "united states of america": "united states",
  usa: "united states",
  "north macedonia": "macedonia",
  eswatini: "swaziland",
  "bosnia and herz.": "bosnia and herzegovina",
  "timor-leste": "east timor",
  "cabo verde": "cape verde",
};

/** Lowercase, accent-free, apostrophe-normalised join key for a country name. */
export function countryKey(name: string): string {
  const k = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return ALIASES[k] ?? k;
}

const DISPLAY: Record<string, string> = {
  "Korea, South": "South Korea",
  "Korea, North": "North Korea",
  "Bahamas, The": "The Bahamas",
  "Gambia, The": "The Gambia",
  "Congo (Brazzaville)": "Republic of the Congo",
  "Congo (Kinshasa)": "DR Congo",
  "Côte D’Ivoire": "Côte d’Ivoire",
  Burma: "Myanmar",
};

/** Country name as people write it ("Korea, South" -> "South Korea", "And" -> "and"). */
export function displayCountry(name: string | undefined): string {
  if (!name) return "";
  if (DISPLAY[name]) return DISPLAY[name];
  return name.replace(/ And /g, " and ");
}
