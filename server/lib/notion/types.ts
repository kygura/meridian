// Shapes shared by the Notion bridge (ADR 0017). Nothing here is the owner's content: it is
// the structure the importer reads and writes.

/** One value of a Notion property, flattened so REST pages and CSV exports look alike. */
export type Cell = string | number | boolean | null | string[] | { start: string; end?: string | null };

/** A database row (REST page, CSV line) or one parsed entry of a page. `id` is the Notion page id when there is one. */
export interface NotionRow {
  id: string;
  url?: string;
  lastEdited?: string;
  cells: Record<string, Cell>;
}

/** Which property holds what. Defaults match the owner's Travel Seasons database; every name can be changed in Settings. */
export interface SeasonsMapping {
  /** Title of the row; used as the window's reason when there are no notes. */
  title: string;
  /** The place the row is about (select or text). */
  place: string;
  /** Peak / shoulder / avoid, as a select or text. Labels are read by keyword. */
  kind: string;
  /** Date range; only the months are used, so the year does not matter. */
  start: string;
  end: string;
  /** Free text kept as the window's reason. */
  notes: string;
  /** Optional country column, which narrows the city match. */
  country: string;
}

export interface ResearchMapping {
  name: string;
  country: string;
  /** "base" or "pass-through" (hub/transit also read as pass-through). */
  type: string;
  /** Single text property such as "3-6 months", or the two numeric ones below. */
  stay: string;
  stayMin: string;
  stayMax: string;
  /** Text such as "EUR 800-1,500/mo", or numeric min/max with a currency. */
  budget: string;
  budgetMin: string;
  budgetMax: string;
  currency: string;
  notes: string;
  /** The overall score. Every other numeric property is kept as the owner's own sub-score. */
  overall: string;
}

export const DEFAULT_SEASONS_MAPPING: SeasonsMapping = {
  title: "Window",
  place: "Location",
  kind: "Season",
  start: "Start",
  end: "End",
  notes: "Notes",
  country: "Country",
};

export const DEFAULT_RESEARCH_MAPPING: ResearchMapping = {
  name: "Name",
  country: "Country",
  type: "Type",
  stay: "Stay",
  stayMin: "Min nights",
  stayMax: "Max nights",
  budget: "Monthly budget",
  budgetMin: "Budget min",
  budgetMax: "Budget max",
  currency: "Currency",
  notes: "Notes",
  overall: "Score",
};

export interface NotionConfig {
  /** Database ids (URLs are normalised on save). Env values apply where these are unset. */
  seasonsDb?: string;
  /** Location Research kept as a database... */
  researchDb?: string;
  /** ...or as a page with a score table and a paragraph per place. */
  researchPage?: string;
  seasons: SeasonsMapping;
  research: ResearchMapping;
  /** Label (folded) to the Meridian city ids the owner chose for it; [] = ignore the label. */
  aliases: Record<string, string[]>;
  /** Apply the import without a preview on the daily job. Off by default. */
  daily: boolean;
  /** Write the active rotation to a Notion database. Off by default and needs NOTION_WRITE_BACK=1. */
  writeBack: { enabled: boolean; database?: string };
}

export const DEFAULT_CONFIG: NotionConfig = {
  seasons: { ...DEFAULT_SEASONS_MAPPING },
  research: { ...DEFAULT_RESEARCH_MAPPING },
  aliases: {},
  daily: false,
  writeBack: { enabled: false },
};

/** One Location Research entry as read from Notion, before it is matched to a city. */
export interface ResearchEntry {
  ref: string;
  label: string;
  country?: string;
  type?: "base" | "pass-through";
  stay?: { minNights?: number; maxNights?: number };
  budgetMonthly?: { min: number; max?: number; currency: string };
  notes?: string;
  /** The owner's own scores by dimension, as written. */
  scores: Record<string, number>;
  overall?: number;
  sourceUpdated?: string;
}

/** A matched entry in the candidate place pool. */
export interface PoolEntry extends ResearchEntry {
  cityId: string;
  cityName: string;
  cityCountry: string;
  importedAt: string;
}

export interface WindowDraft {
  ref: string;
  cityId: string;
  kind: "peak" | "shoulder" | "avoid";
  months: { start: number; end: number };
  reason?: string;
}

export interface ReviewItem {
  /** Stable key: database + folded label. */
  key: string;
  db: "seasons" | "research";
  label: string;
  reason: "no-match" | "ambiguous" | "compound" | "bad-dates" | "bad-kind";
  detail: string;
  /** Rows (or entries) waiting behind this label. */
  count: number;
  suggestions: { cityId: string; name: string; country: string }[];
}
