// Nature phenomena the owner cares about (ADR 0021). These are definitions of what to look
// up, not events: where and when each one happens is measured from iNaturalist observations
// at run time. Add a phenomenon here and the rolling check picks it up.

export interface Phenomenon {
  id: string;
  /** Event title, e.g. "Jacaranda bloom". */
  title: string;
  /** Scientific names, resolved to iNaturalist taxon ids at run time. Several names are queried together. */
  taxonNames: string[];
  /** Annotation filter, e.g. flowering: term_id 12, term_value_id 13. Without it every observation counts. */
  annotation?: { termId: number; termValueId: number };
  tags: string[];
  /** Fewer verifiable observations than this within the radius and no event is made. */
  minObservations: number;
  /** Latitude band the phenomenon can occur in; places outside it are not checked. */
  latBand?: [number, number];
  /** Countries not checked here because another source covers them (cherry blossom in Japan is the JMA source). */
  skipCountries?: string[];
}

const FLOWERING = { termId: 12, termValueId: 13 } as const;

export const PHENOMENA: Phenomenon[] = [
  { id: "cherry-blossom", title: "Cherry blossom", taxonNames: ["Prunus serrulata"], annotation: FLOWERING, tags: ["cherry-blossom", "nature"], minObservations: 8, latBand: [20, 65], skipCountries: ["Japan"] },
  { id: "jacaranda", title: "Jacaranda bloom", taxonNames: ["Jacaranda mimosifolia"], annotation: FLOWERING, tags: ["jacaranda", "bloom", "nature"], minObservations: 8, latBand: [-45, 40] },
  { id: "lavender", title: "Lavender bloom", taxonNames: ["Lavandula angustifolia"], annotation: FLOWERING, tags: ["lavender", "bloom", "nature"], minObservations: 8, latBand: [30, 60] },
  { id: "tulips", title: "Tulip season", taxonNames: ["Tulipa"], annotation: FLOWERING, tags: ["tulips", "bloom", "nature"], minObservations: 10, latBand: [30, 65] },
  { id: "bluebells", title: "Bluebell season", taxonNames: ["Hyacinthoides non-scripta"], annotation: FLOWERING, tags: ["bluebells", "bloom", "nature"], minObservations: 8, latBand: [40, 62] },
  { id: "humpback-whales", title: "Humpback whale season", taxonNames: ["Megaptera novaeangliae"], tags: ["whales", "humpback-whales", "wildlife", "nature"], minObservations: 10 },
  { id: "grey-whales", title: "Grey whale season", taxonNames: ["Eschrichtius robustus"], tags: ["whales", "grey-whales", "wildlife", "nature"], minObservations: 10 },
  { id: "sea-turtles", title: "Sea turtle season", taxonNames: ["Chelonia mydas", "Caretta caretta"], tags: ["sea-turtles", "wildlife", "nature"], minObservations: 10, latBand: [-40, 40] },
  { id: "monarch-butterflies", title: "Monarch butterfly season", taxonNames: ["Danaus plexippus"], tags: ["monarch-butterflies", "wildlife", "nature"], minObservations: 15 },
  { id: "fireflies", title: "Firefly season", taxonNames: ["Lampyridae"], tags: ["fireflies", "wildlife", "nature"], minObservations: 15 },
  { id: "wildebeest", title: "Wildebeest season", taxonNames: ["Connochaetes taurinus"], tags: ["wildebeest", "wildlife", "nature"], minObservations: 10, latBand: [-35, 10] },
];
