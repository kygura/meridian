import { useRef, useState, type DragEvent } from "react";
import { Button, IconButton, Spinner } from "../../ui";
import { IconAlert, IconCheck, IconClose, IconUpload } from "../../ui/icons";
import type { UploadJob } from "./useUploads";
import { progressLine } from "./inboxText";

export interface UploadPanelProps {
  jobs: UploadJob[];
  busy: boolean;
  onFiles: (files: File[]) => void;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Lets the page header's "Upload files" button open the same picker. */
  pickerRef?: React.RefObject<HTMLInputElement | null>;
}

const ACCEPT = ".eml,.mbox,.json,application/json,image/*";

/** One dropzone for every import kind (email, location history, photos) plus the upload progress list. */
export default function UploadPanel({ jobs, busy, onFiles, onCancel, onDismiss, pickerRef }: UploadPanelProps) {
  const ownPicker = useRef<HTMLInputElement>(null);
  const picker = pickerRef ?? ownPicker;
  const folder = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const take = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (files.length) onFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (!busy) take(e.dataTransfer.files);
  };

  return (
    <section className="inbox-upload" aria-label="Import files">
      <div
        className="inbox-drop"
        data-over={over || undefined}
        data-busy={busy || undefined}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          if (!busy) setOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
      >
        <span className="inbox-drop-icon" aria-hidden="true">
          <IconUpload size={24} />
        </span>
        <div className="inbox-drop-text">
          <p className="inbox-drop-title">{over ? "Drop to import" : "Drop files here to import"}</p>
          <p className="inbox-drop-hint">
            Booking emails (.eml or .mbox), a location history export (.json), or photos. Photos stay on this device: only
            their time, place and a fingerprint are sent.
          </p>
        </div>
        <div className="inbox-drop-actions">
          <Button size="sm" disabled={busy} onClick={() => picker.current?.click()}>
            Choose files
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => folder.current?.click()}>
            Choose a photo folder
          </Button>
        </div>
        <input
          ref={picker}
          className="sr-only"
          type="file"
          multiple
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={folder}
          className="sr-only"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {jobs.length > 0 && (
        <ul className="inbox-jobs" aria-label="Uploads" aria-live="polite">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => onCancel(j.id)} onDismiss={() => onDismiss(j.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job: j, onCancel, onDismiss }: { job: UploadJob; onCancel: () => void; onDismiss: () => void }) {
  const active = j.phase === "reading" || j.phase === "sending";
  const pct = j.total ? Math.round(((j.done ?? 0) / j.total) * 100) : undefined;
  const status =
    j.phase === "queued"
      ? "Waiting"
      : j.phase === "reading" && j.total
        ? progressLine(j.done ?? 0, j.total)
        : j.phase === "sending"
          ? j.total && j.total > 1
            ? `Uploading ${j.done ?? 0} of ${j.total}`
            : "Uploading"
          : j.summary ?? "";
  return (
    <li className="inbox-job" data-phase={j.phase}>
      <span className="inbox-job-icon" aria-hidden="true">
        {active || j.phase === "queued" ? <Spinner size={16} /> : j.phase === "error" ? <IconAlert size={18} /> : <IconCheck size={18} />}
      </span>
      <div className="inbox-job-main">
        <p className="inbox-job-label">{j.label}</p>
        <p className="inbox-job-status">{status}</p>
        {active && pct !== undefined && (
          <div className="inbox-bar" role="progressbar" aria-label={`${j.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {j.errors && j.errors.length > 0 && (
          <details className="inbox-job-errors">
            <summary>{j.errors.length === 1 ? "1 item couldn't be read" : `${j.errors.length} items couldn't be read`}</summary>
            <ul>
              {j.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {active ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      ) : j.phase !== "queued" ? (
        <IconButton size="sm" label={`Dismiss ${j.label}`} icon={<IconClose size={16} />} onClick={onDismiss} />
      ) : null}
    </li>
  );
}
