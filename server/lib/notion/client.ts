// Minimal Notion REST client (no SDK): query a database, read a page's blocks as Markdown,
// create and update pages for the optional write-back. The token comes from NOTION_TOKEN
// and is sent only to api.notion.com.

import type { Cell, NotionRow } from "./types.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const MAX_PAGES = 50; // 5,000 rows is far beyond a personal planning database
const MAX_RETRIES = 3;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class NotionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NotionError";
  }
}

export interface NotionClient {
  queryDatabase(id: string): Promise<NotionRow[]>;
  pageMarkdown(id: string): Promise<string>;
  createPage(body: unknown): Promise<{ id: string }>;
  updatePage(id: string, body: unknown): Promise<void>;
}

export function notionToken(): string | undefined {
  return process.env.NOTION_TOKEN?.trim() || undefined;
}

/** Accepts a bare id, a dashed uuid or a notion.so URL; returns the 32 hex characters, or undefined. */
export function normaliseNotionId(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const hex = input.replace(/\?.*$/, "").match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)?.at(-1);
  return hex?.replace(/-/g, "").toLowerCase();
}

export function createNotionClient(token: string, fetchImpl: FetchLike = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): NotionClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = Math.min(10, Number(res.headers.get("retry-after")) || 1);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) {
        // The body can quote page content, so only the status and Notion's error code are kept.
        const j = (await res.json().catch(() => ({}))) as { code?: string };
        throw new NotionError(res.status, `Notion answered ${res.status}${j.code ? ` (${j.code})` : ""}`);
      }
      return (await res.json()) as T;
    }
  }

  async function paged<T>(first: (cursor?: string) => Promise<{ results: T[]; has_more?: boolean; next_cursor?: string | null }>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await first(cursor);
      out.push(...r.results);
      if (!r.has_more || !r.next_cursor) return out;
      cursor = r.next_cursor;
    }
    throw new NotionError(413, "Notion returned more pages than the importer reads");
  }

  async function blocks(id: string): Promise<Block[]> {
    return paged<Block>((cursor) => call("GET", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`));
  }

  return {
    async queryDatabase(id) {
      const pages = await paged<RestPage>((cursor) => call("POST", `/databases/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
      return pages.filter((p) => !p.archived && !p.in_trash).map(pageToRow);
    },
    async pageMarkdown(id) {
      const top = await blocks(id);
      for (const b of top) if (b.type === "table" && b.has_children) b.children = await blocks(b.id);
      return blocksToMarkdown(top);
    },
    createPage: (body) => call("POST", "/pages", body),
    async updatePage(id, body) {
      await call("PATCH", `/pages/${id}`, body);
    },
  };
}

// ── Pages → rows ─────────────────────────────────────────────────────

interface RichText {
  plain_text: string;
  annotations?: { bold?: boolean; italic?: boolean };
}
interface RestProperty {
  type: string;
  [k: string]: unknown;
}
export interface RestPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, RestProperty>;
}

const plain = (rt: unknown): string => (Array.isArray(rt) ? (rt as RichText[]).map((t) => t.plain_text).join("") : "");

function propertyToCell(p: RestProperty): Cell {
  const v = p[p.type] as never as Record<string, unknown> | unknown[] | string | number | boolean | null;
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return (v as { name?: string } | null)?.name ?? null;
    case "multi_select":
      return (v as { name: string }[]).map((o) => o.name);
    case "number":
    case "checkbox":
      return v as number | boolean | null;
    case "date": {
      const d = v as { start: string; end?: string | null } | null;
      return d ? { start: d.start, end: d.end ?? null } : null;
    }
    case "url":
    case "email":
    case "phone_number":
      return (v as string | null) ?? null;
    case "place": {
      const pl = v as { name?: string; address?: string } | null;
      return pl?.name ?? pl?.address ?? null;
    }
    case "formula": {
      const f = v as { type: string; [k: string]: unknown };
      return f ? propertyToCell(f as RestProperty) : null;
    }
    default:
      return null; // relations, rollups, people, files: not read
  }
}

export function pageToRow(p: RestPage): NotionRow {
  const cells: Record<string, Cell> = {};
  for (const [name, prop] of Object.entries(p.properties ?? {})) cells[name] = propertyToCell(prop);
  return { id: p.id.replace(/-/g, ""), url: p.url, lastEdited: p.last_edited_time, cells };
}

// ── Blocks → Markdown (just enough for headings, paragraphs and tables) ─

interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  children?: Block[];
  [k: string]: unknown;
}

function inline(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return (rt as RichText[])
    .map((t) => {
      let s = t.plain_text;
      if (!s.trim()) return s;
      if (t.annotations?.bold) s = `**${s.trim()}**`;
      if (t.annotations?.italic) s = `*${s.trim()}*`;
      return s;
    })
    .join("");
}

export function blocksToMarkdown(list: Block[]): string {
  const out: string[] = [];
  for (const b of list) {
    const body = b[b.type] as { rich_text?: unknown; has_column_header?: boolean } | undefined;
    if (b.type === "heading_1") out.push(`# ${inline(body?.rich_text)}`);
    else if (b.type === "heading_2") out.push(`## ${inline(body?.rich_text)}`);
    else if (b.type === "heading_3") out.push(`### ${inline(body?.rich_text)}`);
    else if (b.type === "paragraph" || b.type === "quote" || b.type === "callout") {
      const t = inline(body?.rich_text);
      if (t.trim()) out.push(t);
    } else if (b.type === "bulleted_list_item" || b.type === "numbered_list_item") out.push(`- ${inline(body?.rich_text)}`);
    else if (b.type === "table") {
      const rows = (b.children ?? []).map((r) => ((r.table_row as { cells: unknown[] } | undefined)?.cells ?? []).map((c) => inline(c).replace(/\|/g, "/")));
      const lines: string[] = [];
      rows.forEach((cells, i) => {
        lines.push(`| ${cells.join(" | ")} |`);
        if (i === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
      if (lines.length) out.push(lines.join("\n"));
    }
  }
  return out.join("\n\n");
}
