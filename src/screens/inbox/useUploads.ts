import { useCallback, useRef, useState } from "react";
import { JournalLockedError, uploadEmail, uploadPhotos, uploadTimeline } from "../../lib/journalApi";
import { isImageFile, mergeReports, scanPhotos, uploadKind, type ExifTags, type UploadKind, type UploadReport } from "../../lib/importUpload";
import type { ImportReport } from "../../types";
import { count, errorText, reportSummary } from "./inboxText";

export type JobPhase = "queued" | "reading" | "sending" | "done" | "error";

export interface UploadJob {
  id: string;
  kind: UploadKind | "unknown";
  /** "3 email files", "Location history", "212 photos". */
  label: string;
  phase: JobPhase;
  done?: number;
  total?: number;
  /** Plain-words result once finished. */
  summary?: string;
  /** Per-item errors from the server report. */
  errors?: string[];
  /** Something was added, so the queue may have new items. */
  added?: number;
}

/**
 * exifr reads the first chunk of each image; only DateTimeOriginal and the GPS block are parsed
 * (`pick` would drop the derived latitude/longitude, so the other segments are switched off instead).
 * The image bytes never leave the device (lib/importUpload privacy contract).
 */
async function exifParse(file: File): Promise<ExifTags | undefined> {
  const exifr = await import("exifr");
  return (await exifr.parse(file, {
    tiff: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, interop: false, ifd1: false,
    exif: { pick: ["DateTimeOriginal"] },
    gps: true,
  })) as ExifTags | undefined;
}

let seq = 0;
const nextId = () => `up-${++seq}`;

/** Split a mixed selection into the three import kinds; anything else is reported, not sent. */
export function groupFiles(files: File[]): { email: File[]; timeline: File[]; photo: File[]; other: File[] } {
  const out = { email: [] as File[], timeline: [] as File[], photo: [] as File[], other: [] as File[] };
  for (const f of files) {
    const k = uploadKind(f.name);
    if (k === "email") out.email.push(f);
    else if (k === "timeline") out.timeline.push(f);
    else if (isImageFile(f)) out.photo.push(f);
    else out.other.push(f);
  }
  return out;
}

/** Upload queue for the inbox: one job per kind of file, run one after another, each with its own result line. */
export function useUploads(onUploaded: () => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<string | null>(null);
  const running = useRef(false);

  const patch = (id: string, p: Partial<UploadJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const finish = (id: string, report: UploadReport) =>
    patch(id, { phase: "done", summary: reportSummary(report), errors: report.errors, added: report.added });

  const runOne = async (job: UploadJob, files: File[]) => {
    const reports: ImportReport[] = [];
    let note: string | undefined;
    const cancelled = () => cancelRef.current === job.id;
    try {
      if (job.kind === "photo") {
        patch(job.id, { phase: "reading", done: 0, total: files.length });
        const scan = await scanPhotos(files, {
          parse: exifParse,
          onProgress: (done, total) => patch(job.id, { done, total }),
          shouldCancel: cancelled,
        });
        note = scan.skipped ? `${count(scan.skipped, "photo")} without a time or location skipped` : undefined;
        if (scan.cancelled) return finish(job.id, { received: 0, added: 0, duplicates: 0, note: "Cancelled. Nothing was sent" });
        if (!scan.points.length) return finish(job.id, { received: 0, added: 0, duplicates: 0, note: note ?? "No photos with a location found" });
        patch(job.id, { phase: "sending", done: undefined, total: undefined });
        return finish(job.id, await uploadPhotos(scan.points, { note, shouldCancel: cancelled }));
      }
      patch(job.id, { phase: "sending", done: 0, total: files.length });
      for (const f of files) {
        if (cancelled()) break;
        reports.push(await (job.kind === "email" ? uploadEmail(f) : uploadTimeline(f)));
        patch(job.id, { done: reports.length });
      }
      finish(job.id, mergeReports(reports, cancelled() ? "Cancelled" : undefined));
    } catch (e) {
      // Batches/files saved before the failure still count.
      const partial = job.kind === "photo" ? (e as { partial?: ImportReport[] }).partial : reports;
      const saved = partial?.length ? reportSummary(mergeReports(partial, note)) : undefined;
      const msg = e instanceof JournalLockedError ? "Your journal is locked. Unlock it and try again." : errorText(e);
      patch(job.id, { phase: "error", summary: saved ? `${msg} ${saved}` : msg, added: partial?.reduce((n, r) => n + r.added, 0) });
    }
  };

  const start = useCallback(
    async (files: File[]) => {
      if (running.current || files.length === 0) return;
      const g = groupFiles(files);
      const plan: Array<{ job: UploadJob; files: File[] }> = [];
      if (g.email.length) plan.push({ job: { id: nextId(), kind: "email", label: count(g.email.length, "email file"), phase: "queued" }, files: g.email });
      if (g.timeline.length)
        plan.push({ job: { id: nextId(), kind: "timeline", label: g.timeline.length === 1 ? "Location history" : count(g.timeline.length, "location history file"), phase: "queued" }, files: g.timeline });
      if (g.photo.length) plan.push({ job: { id: nextId(), kind: "photo", label: count(g.photo.length, "photo"), phase: "queued" }, files: g.photo });
      const skipped: UploadJob[] = g.other.length
        ? [{ id: nextId(), kind: "unknown", label: count(g.other.length, "file"), phase: "error", summary: "Skipped. Use email files (.eml, .mbox), a location history export (.json) or photos." }]
        : [];
      setJobs((js) => [...plan.map((p) => p.job), ...skipped, ...js].slice(0, 8));
      if (!plan.length) return;
      running.current = true;
      setBusy(true);
      try {
        for (const p of plan) {
          cancelRef.current = null;
          await runOne(p.job, p.files);
        }
      } finally {
        running.current = false;
        cancelRef.current = null;
        setBusy(false);
        onUploaded();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onUploaded]
  );

  const cancel = useCallback((id: string) => {
    cancelRef.current = id;
  }, []);

  const dismiss = useCallback((id: string) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.phase === "queued" || j.phase === "reading" || j.phase === "sending")), []);

  return { jobs, busy, start, cancel, dismiss, clearFinished };
}
