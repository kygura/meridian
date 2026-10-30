import { useState } from "react";
import type { UploadReport } from "../../lib/importUpload";

const Dot = () => (
  <span className="jr-report-dim" aria-hidden="true">
    ·
  </span>
);

/** The latest upload's report as one teletype row (DESIGN-journal §8). `errors` expands into a list. */
export default function ImportReportStrip({ report, label, onDismiss }: { report: UploadReport; label?: string; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const n = (v: number) => v.toLocaleString("en-US");
  const errors = report.errors ?? [];
  return (
    <div className="jr-report" role="status">
      <div className="jr-report-row">
        {label && <span className="jr-report-label">{label}</span>}
        <span>RECEIVED {n(report.received)}</span>
        <Dot />
        <span className="jr-report-added">ADDED {n(report.added)}</span>
        <Dot />
        <span className="jr-report-dim">DUPLICATES {n(report.duplicates)}</span>
        {report.unstructured !== undefined && (
          <>
            <Dot />
            <span className="jr-report-dim">UNSTRUCTURED {n(report.unstructured)}</span>
          </>
        )}
        {report.note && (
          <>
            <Dot />
            <span className="jr-report-dim">{report.note}</span>
          </>
        )}
        {errors.length > 0 && (
          <button type="button" className="jr-report-errs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {errors.length} {errors.length === 1 ? "ERROR" : "ERRORS"} {open ? "▴" : "▾"}
          </button>
        )}
        <button type="button" className="jr-x jr-report-x" aria-label="Dismiss report" onClick={onDismiss}>
          ✕
        </button>
      </div>
      {open && (
        <ul className="jr-report-list">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
