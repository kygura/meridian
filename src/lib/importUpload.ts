// Pure helpers for the inbox uploads (DESIGN-journal.md §8, spec-journal.md §7). No React, no fetch.
//
// Privacy contract: a photo leaves the browser only as {timestamp, lat, lng, hash}. The image bytes are
// read on this device to compute the hash and are never sent. `photoPoint` is the only place a payload
// is built, and its test pins the exact key set.

import type { ImportReport } from "../types";

/** The only fields of a photo that are ever uploaded. */
export interface PhotoPoint {
  timestamp: string;
  lat: number;
  lng: number;
  hash: string;
}
export const PHOTO_KEYS = ["timestamp", "lat", "lng", "hash"] as const;

/** Server max per POST /photos (5000 points is ~650 KB, well under the 2 MB body limit). */
export const PHOTO_BATCH = 5000;
/** Server limit for POST /upload/email and /upload/timeline bodies (25 MiB); larger files are refused before reading. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Hash input is the first 1 MiB of the file plus its byte size: fast on big RAW/HEIC folders, and
 *  stable enough as a dedupe fingerprint (it is not a content proof). */
export const HASH_HEAD_BYTES = 1024 * 1024;

const dayNo = (ts: string): number => Date.parse(ts.slice(0, 10) + "T00:00:00Z") / 86_400_000;

/**
 * Time-sorted batches of at most `size`. The server builds stops per request and groups consecutive days, so one
 * stay must not straddle two requests: a full batch is cut at the latest gap of more than one day; only when it
 * has none (one run longer than `size`) at a date change, and then hard.
 */
export function photoBatches(points: PhotoPoint[], size = PHOTO_BATCH): PhotoPoint[][] {
  const sorted = [...points].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const out: PhotoPoint[][] = [];
  let i = 0;
  while (i < sorted.length) {
    let end = Math.min(i + size, sorted.length);
    if (end < sorted.length) {
      const back = (apart: (prev: string, next: string) => boolean): number => {
        let cut = end;
        while (cut > i && !apart(sorted[cut - 1].timestamp, sorted[cut].timestamp)) cut--;
        return cut;
      };
      const cut = back((p, n) => dayNo(n) - dayNo(p) > 1);
      const dateCut = cut > i ? cut : back((p, n) => p.slice(0, 10) !== n.slice(0, 10));
      if (dateCut > i) end = dateCut;
    }
    out.push(sorted.slice(i, end));
    i = end;
  }
  return out;
}

// ── File kinds ───────────────────────────────────────────────────────

export type UploadKind = "email" | "timeline" | "photo";

const IMAGE_EXT = /\.(jpe?g|heic|heif|png|tiff?|webp|avif)$/i;

export function isImageFile(f: { name: string; type?: string }): boolean {
  return (f.type ?? "").startsWith("image/") || IMAGE_EXT.test(f.name);
}

/** .eml/.mbox -> email, .json -> timeline, anything else null. */
export function uploadKind(name: string): Exclude<UploadKind, "photo"> | null {
  if (/\.(eml|mbox)$/i.test(name)) return "email";
  if (/\.json$/i.test(name)) return "timeline";
  return null;
}

/** Raw-body content type for POST /upload/email. */
export function emailContentType(name: string): string {
  return /\.mbox$/i.test(name) ? "application/mbox" : "message/rfc822";
}

// ── EXIF -> PhotoPoint ───────────────────────────────────────────────

/**
 * Wall-clock ISO without a zone ("2024-05-14T10:03:22"). EXIF times carry no zone and exifr revives them as a
 * Date in the browser's local timezone, so the local getters give back exactly what the camera wrote (checked
 * under a non-UTC timezone). The server keeps the written date.
 */
export function wallClockIso(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The subset of exifr's output we look at. */
export interface ExifTags {
  DateTimeOriginal?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Time + place from exifr tags; null when either is missing or implausible (photos without GPS are skipped). */
export function photoMeta(tags: ExifTags | null | undefined): Omit<PhotoPoint, "hash"> | null {
  if (!tags) return null;
  const when = tags.DateTimeOriginal;
  const date = when instanceof Date ? when : typeof when === "string" ? new Date(when) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const { latitude: lat, longitude: lng } = tags;
  if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null; // the "no fix" placeholder some cameras write
  return { timestamp: wallClockIso(date), lat, lng };
}

/** Builds the upload record with exactly {timestamp, lat, lng, hash}; any other field is dropped by construction. */
export function photoPoint(meta: Omit<PhotoPoint, "hash">, hash: string): PhotoPoint {
  return { timestamp: meta.timestamp, lat: meta.lat, lng: meta.lng, hash };
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 over (first HASH_HEAD_BYTES of the file) + ":" + byte size. Only a digest leaves this function. */
export async function fingerprintFile(
  file: Pick<Blob, "size" | "slice">,
  subtle: Pick<SubtleCrypto, "digest"> = crypto.subtle
): Promise<string> {
  const head = new Uint8Array(await file.slice(0, HASH_HEAD_BYTES).arrayBuffer());
  const tail = new TextEncoder().encode(`:${file.size}`);
  const input = new Uint8Array(head.length + tail.length);
  input.set(head);
  input.set(tail, head.length);
  return hex(await subtle.digest("SHA-256", input));
}

export interface PhotoScan {
  points: PhotoPoint[];
  /** Image files looked at. */
  scanned: number;
  /** Images skipped for no usable time or GPS (or unreadable EXIF). */
  skipped: number;
  cancelled: boolean;
}

/**
 * Reads time + GPS from each image on this device and hashes it. `parse` is exifr's parse (injected so tests
 * can mock it); `hash` defaults to fingerprintFile. Non-image files are ignored, a file whose EXIF throws counts as skipped.
 */
export async function scanPhotos(
  files: File[],
  opts: {
    parse: (file: File) => Promise<ExifTags | null | undefined>;
    hash?: (file: File) => Promise<string>;
    onProgress?: (done: number, total: number) => void;
    shouldCancel?: () => boolean;
    concurrency?: number;
  }
): Promise<PhotoScan> {
  const images = files.filter(isImageFile);
  const hash = opts.hash ?? ((f: File) => fingerprintFile(f));
  const width = Math.max(1, opts.concurrency ?? 6);
  const out: PhotoScan = { points: [], scanned: 0, skipped: 0, cancelled: false };
  for (let i = 0; i < images.length; i += width) {
    if (opts.shouldCancel?.()) {
      out.cancelled = true;
      break;
    }
    const group = images.slice(i, i + width);
    const results = await Promise.all(
      group.map(async (f) => {
        try {
          const meta = photoMeta(await opts.parse(f));
          return meta ? photoPoint(meta, await hash(f)) : null;
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      out.scanned++;
      if (r) out.points.push(r);
      else out.skipped++;
    }
    opts.onProgress?.(out.scanned, images.length);
  }
  return out;
}

// ── Reports ──────────────────────────────────────────────────────────

/** An ImportReport plus an optional one-line note (e.g. photos skipped for lack of GPS). */
export type UploadReport = ImportReport & { note?: string };

/** Sums the per-batch reports of one upload. */
export function mergeReports(reports: ImportReport[], note?: string): UploadReport {
  const sum = (k: "received" | "added" | "duplicates") => reports.reduce((n, r) => n + (r[k] ?? 0), 0);
  const unstructured = reports.reduce((n, r) => n + (r.unstructured ?? 0), 0);
  const errors = reports.flatMap((r) => r.errors ?? []);
  return {
    received: sum("received"),
    added: sum("added"),
    duplicates: sum("duplicates"),
    ...(reports.some((r) => r.unstructured !== undefined) ? { unstructured } : {}),
    ...(errors.length ? { errors } : {}),
    ...(note ? { note } : {}),
  };
}

/** `READING 412 / 1,280 · ON THIS DEVICE` */
export function progressText(done: number, total: number): string {
  return `READING ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} · ON THIS DEVICE`;
}
