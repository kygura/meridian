import { useRef, useState } from "react";
import { JournalLockedError, uploadEmail, uploadPhotos, uploadTimeline } from "../../lib/journalApi";
import { inboxErrorText } from "../../lib/inbox";
import { isImageFile, mergeReports, progressText, scanPhotos, uploadKind, type ExifTags, type UploadKind, type UploadReport } from "../../lib/importUpload";
import type { ImportReport } from "../../types";

interface Tile {
  kind: UploadKind;
  title: string;
  sub: string;
  accept: string;
  button: string;
}

const TILES: Tile[] = [
  { kind: "email", title: "EMAIL", sub: "Booking confirmations with structured markup. Others are counted, not guessed.", accept: ".eml,.mbox", button: "CHOOSE FILE" },
  { kind: "timeline", title: "LOCATION HISTORY", sub: "Nights away from home become stops. The file isn't kept.", accept: ".json,application/json", button: "CHOOSE FILE" },
  { kind: "photo", title: "PHOTOS", sub: "Only time, place and a fingerprint of each photo leave this device — never the images.", accept: "image/*", button: "CHOOSE FOLDER" },
];

/**
 * exifr reads the first chunk of each image; only the EXIF DateTimeOriginal and the GPS block are parsed
 * (`pick` would drop the derived latitude/longitude, so the other segments are switched off instead).
 */
async function exifParse(file: File): Promise<ExifTags | undefined> {
  const exifr = await import("exifr");
  return (await exifr.parse(file, {
    tiff: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, interop: false, ifd1: false,
    exif: { pick: ["DateTimeOriginal"] },
    gps: true,
  })) as ExifTags | undefined;
}

/** Three drop targets: email files, a Timeline export, a photo folder (DESIGN-journal §8). */
export default function UploadDock({
  onReport,
  onUploaded,
}: {
  onReport: (report: UploadReport, label: string) => void;
  /** Called after every attempt so the parent can refetch the queue. */
  onUploaded: () => void;
}) {
  const [active, setActive] = useState<UploadKind | null>(null);
  const [over, setOver] = useState<UploadKind | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const cancelled = useRef(false);

  const run = async (kind: UploadKind, files: File[]) => {
    if (active || files.length === 0) return;
    setError(null);
    setActive(kind);
    cancelled.current = false;
    const reports: ImportReport[] = [];
    let note: string | undefined;
    try {
      let report: UploadReport;
      if (kind === "photo") {
        const images = files.filter(isImageFile);
        if (images.length === 0) throw Object.assign(new Error("no_images"), { code: "no_images" });
        setProgress({ done: 0, total: images.length });
        const scan = await scanPhotos(images, {
          parse: exifParse,
          onProgress: (done, total) => setProgress({ done, total }),
          shouldCancel: () => cancelled.current,
        });
        setProgress(null);
        setSending(!scan.cancelled && scan.points.length > 0);
        note = scan.skipped ? `${scan.skipped.toLocaleString("en-US")} ${scan.skipped === 1 ? "PHOTO" : "PHOTOS"} WITHOUT TIME OR GPS SKIPPED` : undefined;
        report = scan.cancelled
          ? { received: 0, added: 0, duplicates: 0, note: "CANCELLED · NOTHING SENT" }
          : scan.points.length
          ? await uploadPhotos(scan.points, { note, shouldCancel: () => cancelled.current })
          : { received: 0, added: 0, duplicates: 0, note: note ?? "NO PHOTOS WITH GPS FOUND" };
      } else {
        for (const f of files) reports.push(await (kind === "email" ? uploadEmail(f) : uploadTimeline(f)));
        report = mergeReports(reports);
      }
      onReport(report, TILES.find((t) => t.kind === kind)!.title);
    } catch (e) {
      // Batches/files saved before the failure still count: show their report next to the error.
      const partial = kind === "photo" ? (e as { partial?: ImportReport[] }).partial : reports;
      if (partial?.length) onReport(mergeReports(partial, note), TILES.find((t) => t.kind === kind)!.title);
      if (!(e instanceof JournalLockedError)) {
        setError((e as { code?: string }).code === "no_images" ? "⚠ NO IMAGES IN THAT SELECTION" : (e as { code?: string }).code === "invalid_json" ? "⚠ THAT FILE ISN'T VALID JSON" : inboxErrorText(e));
      }
    } finally {
      setActive(null);
      setProgress(null);
      setSending(false);
      onUploaded();
    }
  };

  const onDrop = (kind: UploadKind) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const all = [...e.dataTransfer.files];
    const ok = kind === "photo" ? all.filter(isImageFile) : all.filter((f) => uploadKind(f.name) === (kind === "email" ? "email" : "timeline"));
    if (ok.length === 0) {
      setError(kind === "photo" ? "⚠ DROP IMAGE FILES, OR USE CHOOSE FOLDER FOR A WHOLE FOLDER" : kind === "email" ? "⚠ DROP A .EML OR .MBOX FILE" : "⚠ DROP A TIMELINE .JSON FILE");
      return;
    }
    void run(kind, ok);
  };

  return (
    <div className="jr-dock" aria-label="Import sources">
      <div className="jr-dock-tiles">
        {TILES.map((t) => {
          const busy = active === t.kind;
          const inputId = `jr-up-${t.kind}`;
          return (
            <div
              key={t.kind}
              className={`jr-tile${over === t.kind ? " over" : ""}${busy ? " busy" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!active) setOver(t.kind);
              }}
              onDragLeave={() => setOver((o) => (o === t.kind ? null : o))}
              onDrop={onDrop(t.kind)}
            >
              <div className="jr-label">{t.title}</div>
              <p className="jr-tile-sub">{t.sub}</p>
              {t.kind === "photo" && (
                <>
                  <button type="button" className="tp-link jr-tile-link" aria-expanded={privacy} onClick={() => setPrivacy((v) => !v)}>
                    PRIVACY
                  </button>
                  {privacy && <p className="jr-tile-privacy">SENT PER PHOTO: timestamp · lat · lng · hash</p>}
                </>
              )}
              <input
                id={inputId}
                className="jr-file"
                type="file"
                accept={t.accept}
                multiple={t.kind !== "timeline"}
                {...(t.kind === "photo" ? ({ webkitdirectory: "", directory: "" } as Record<string, string>) : {})}
                tabIndex={-1}
                aria-label={`${t.title} file`}
                disabled={!!active}
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  void run(t.kind, files);
                }}
              />
              {busy && progress && t.kind === "photo" ? (
                <div className="jr-progress">
                  <div className="jr-hint label" role="status">{progressText(progress.done, progress.total)}</div>
                  <div className="jr-bar" aria-hidden="true">
                    <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                  </div>
                  <button type="button" className="tm-action-btn" onClick={() => (cancelled.current = true)}>
                    CANCEL
                  </button>
                </div>
              ) : busy && sending && t.kind === "photo" ? (
                <div className="jr-progress">
                  <div className="jr-hint label" role="status">UPLOADING…</div>
                  <button type="button" className="tm-action-btn" onClick={() => (cancelled.current = true)}>
                    CANCEL
                  </button>
                </div>
              ) : busy ? (
                <div className="jr-hint label" role="status">UPLOADING…</div>
              ) : (
                <button type="button" className="tm-action-btn" disabled={!!active} onClick={() => document.getElementById(inputId)?.click()}>
                  {t.button}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <div className="jr-err" role="alert">
          {error}
        </div>
      )}
      <div className="jr-dock-foot">GMAIL + CALENDAR IMPORT RUNS AS A SCHEDULED CLAUDE TASK · SEE docs/ingest/gmail-import-task.md</div>
    </div>
  );
}
