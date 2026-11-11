// Shared pieces for showing visa checks (ADR 0012) on trips, the rotation, the solver and the
// Days page. Every figure names its source; every block says rules change.

import { Badge, type BadgeTone } from "../../ui";
import { IconExternal } from "../../ui/icons";
import { STATUS_LABEL, limitLabel } from "../../lib/visa/rules";
import { VISA_DISCLAIMER } from "../../lib/visa/data";
import type { StayVerdict, VerdictLevel, Violation } from "../../lib/visa/engine";
import "./visa.css";

export const LEVEL_TONE: Record<VerdictLevel, BadgeTone> = {
  ok: "success",
  free: "success",
  near: "warning",
  visa: "warning",
  over: "danger",
  blocked: "danger",
  unknown: "neutral",
};

export const LEVEL_LABEL: Record<VerdictLevel, string> = {
  ok: "Within limit",
  free: "No limit",
  near: "Close to limit",
  visa: "Visa first",
  over: "Over limit",
  blocked: "No entry",
  unknown: "No data",
};

export function VerdictBadge({ v }: { v: Pick<StayVerdict, "level"> }) {
  return <Badge tone={LEVEL_TONE[v.level]}>{LEVEL_LABEL[v.level]}</Badge>;
}

export function SourceLink({ title, url, checked }: { title: string; url?: string; checked?: string }) {
  const label = `${title}${checked ? `, checked ${checked}` : ""}`;
  if (!url) return <span className="visa-source">{label}</span>;
  return (
    <a className="visa-source" href={url} target="_blank" rel="noopener noreferrer">
      {label}
      <IconExternal size={12} />
    </a>
  );
}

/** One stay's checks: requirement, days allowed against planned, validity, yellow fever. */
export function VerdictDetail({ v, compact }: { v: StayVerdict; compact?: boolean }) {
  const r = v.rule;
  const flags: { tone: BadgeTone; text: string }[] = [];
  if (v.validity?.ok === false) flags.push({ tone: "danger", text: `Passport must be valid until ${v.validity.requiredUntil}` });
  if (v.yellowFever?.requirement === "all" || v.yellowFever?.triggeredBy) flags.push({ tone: "warning", text: "Yellow fever certificate" });
  return (
    <div className={compact ? "visa-detail visa-detail--compact" : "visa-detail"}>
      <div className="visa-detail-head">
        <VerdictBadge v={v} />
        <span className="visa-detail-req">{r ? STATUS_LABEL[r.status] : "No passport set"}</span>
        {flags.map((f) => (
          <Badge key={f.text} tone={f.tone}>
            {f.text}
          </Badge>
        ))}
      </div>
      <p className="visa-detail-msg num">{v.message}</p>
      {!compact && (
        <ul className="visa-detail-list">
          {r?.passport && r.status !== "home" && <li>Checked for your {r.passport} passport.</li>}
          {r?.limit && <li>Limit: {limitLabel(r.limit)}{r.basis === "dataset" ? " (dataset figure, counted per entry)" : ""}.</li>}
          {r?.extension && <li>{r.extension.note}</li>}
          {r?.notes.map((n) => <li key={n}>{n}</li>)}
          {v.validity && (
            <li>
              Passport validity: {v.validity.rule ?? "see the source"}
              {v.validity.requiredUntil ? `, so valid until at least ${v.validity.requiredUntil}` : ""}
              {v.validity.ok === null ? " (add your passport's expiry in Settings › Visas to check it)" : v.validity.ok ? ": yours is." : ": yours is not."}{" "}
              <SourceLink title="FCDO entry requirements" url={v.validity.url} checked={v.validity.updated} />
            </li>
          )}
          {v.yellowFever && (
            <li>
              {v.yellowFever.message} <SourceLink title="WHO yellow fever list" url={v.yellowFever.source.url} />
            </li>
          )}
          {r?.sources.map((s) => (
            <li key={s.url + s.title}>
              <SourceLink title={s.title} url={s.url} checked={s.checked} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ViolationList({ items }: { items: Violation[] }) {
  if (!items.length) return null;
  return (
    <ul className="visa-violations">
      {items.map((x) => (
        <li key={`${x.key}-${x.firstOver}`} className="num">
          <strong>{x.label}</strong>: {x.message.replace(`${x.label}: `, "")} <span className="visa-source">{x.source}</span>
        </li>
      ))}
    </ul>
  );
}

export function VisaDisclaimer() {
  return <p className="visa-disclaimer">{VISA_DISCLAIMER}</p>;
}
