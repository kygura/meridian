// Which parts of a place's articles Claude reads (ADR 0021): the sections that carry seasons,
// season-bearing ones first, cut to a budget of about 12,000 tokens.

import { articleUrl, splitSections, type Section } from "./placeText.js";

export type TextSource = "wikivoyage" | "wikipedia" | "region";

/** One piece of an article that is sent to the model, and where it came from. */
export interface TextBlock {
  source: TextSource;
  /** Article title. */
  article: string;
  /** Section heading, "" for the lead. */
  heading: string;
  url: string;
  text: string;
  priority: number;
}

/** Characters sent per city, about 12,000 tokens at four characters a token. */
export const MAX_CHARS = 48_000;
/** Characters of one section. */
export const MAX_SECTION_CHARS = 6_000;
export const CHARS_PER_TOKEN = 4;

/** Wikivoyage headings of a city or region that carry seasons, by priority (lower is read first). */
const WIKIVOYAGE: [RegExp, number][] = [
  [/^understand$/i, 1],
  [/^climate$/i, 1],
  [/^when to (go|visit)$|^seasons?$/i, 1],
  [/events?|festivals?|holidays?/i, 2],
  [/^do$/i, 3],
  [/^see$/i, 4],
  [/^get in$/i, 5],
];
const WIKIPEDIA: [RegExp, number][] = [[/climate|festivals?|events?|culture|tourism/i, 6]];
const REGION_WIKIVOYAGE: [RegExp, number][] = [
  [/^understand$/i, 1],
  [/^climate$/i, 1],
  [/^when to (go|visit)$/i, 1],
  [/events?|festivals?/i, 2],
  [/^do$/i, 3],
  [/^see$/i, 4],
];

function pick(rules: [RegExp, number][], heading: string): number | undefined {
  for (const [re, p] of rules) if (re.test(heading)) return p;
  return undefined;
}

/** The season-bearing sections of one article as blocks. The lead of a Wikivoyage article and of a Wikipedia article come first in their group. */
export function articleBlocks(source: TextSource, wiki: "wikipedia" | "wikivoyage", title: string, extract: string): TextBlock[] {
  const rules = source === "region" && wiki === "wikivoyage" ? REGION_WIKIVOYAGE : wiki === "wikivoyage" ? WIKIVOYAGE : WIKIPEDIA;
  const blocks: TextBlock[] = [];
  for (const s of splitSections(extract) as Section[]) {
    const priority = s.heading === "" ? (wiki === "wikivoyage" ? 1 : 6) : pick(rules, s.heading);
    if (priority === undefined || !s.text) continue;
    blocks.push({ source, article: title, heading: s.heading, url: articleUrl(wiki, title, s.heading || undefined), text: s.text.slice(0, MAX_SECTION_CHARS), priority });
  }
  return blocks;
}

/** The blocks that fit the budget, lowest priority number first, in the order they will be sent. */
export function selectBlocks(blocks: TextBlock[], maxChars = MAX_CHARS): TextBlock[] {
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
  const out: TextBlock[] = [];
  let used = 0;
  for (const b of sorted) {
    const room = maxChars - used;
    if (room < 200) break;
    const text = b.text.length > room ? b.text.slice(0, room) : b.text;
    out.push({ ...b, text });
    used += text.length;
  }
  return out;
}

/** The text as the model gets it: each block under a label naming its article and section. */
export function promptText(blocks: TextBlock[]): string {
  return blocks.map((b) => `[${b.source}: ${b.article}${b.heading ? ` / ${b.heading}` : " / lead"}]\n${b.text}`).join("\n\n");
}

export const estimateTokens = (blocks: TextBlock[]) => Math.ceil(blocks.reduce((a, b) => a + b.text.length + b.article.length + b.heading.length + 20, 0) / CHARS_PER_TOKEN);
