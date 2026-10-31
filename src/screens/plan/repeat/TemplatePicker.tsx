import { euros, monthName, MONTH_SHORT } from "../../../lib/repeatCopy";
import { monthOf, yearOf } from "../../../lib/journal";
import type { ReplayTemplateRef } from "../../../lib/replayQuery";
import { Card, Field, Select } from "../../../ui";
import type { City, Fingerprint, Journey } from "../../../types";

export interface TemplatePickerProps {
  journeys: Journey[];
  journey: Journey | undefined;
  template: ReplayTemplateRef;
  cityById: Map<string, City>;
  fingerprint: Fingerprint | undefined;
  /** 1-based. */
  month: number | undefined;
  onChange: (t: ReplayTemplateRef) => void;
}

/** What the trip was like, in plain words, with pending values said as such. */
function summary(fp: Fingerprint | undefined, month: number | undefined): { facts: string[]; notes: string[] } {
  const facts: string[] = [];
  const notes: string[] = [];
  if (month) facts.push(monthName(month));
  if (!fp) {
    notes.push("Trip details pending — checks again later");
    return { facts, notes };
  }
  const s = fp.status;
  if (s.tempC === "ok" && typeof fp.tempC === "number") facts.push(`${Math.round(fp.tempC)}°C`);
  if (s.precipMm === "ok" && typeof fp.precipMm === "number") facts.push(`${Math.round(fp.precipMm)} mm rain`);
  if (s.tempC === "pending") notes.push("Weather pending — checks again later");
  else if (s.tempC === "absent") notes.push("No weather recorded");
  if (s.dailySpendEur === "ok" && typeof fp.dailySpendEur === "number") facts.push(`${euros(fp.dailySpendEur)} a day`);
  else if (s.dailySpendEur === "pending") notes.push("Costs pending — checks again later");
  else notes.push("No costs recorded");
  if (s.crowdProxy === "ok" && typeof fp.crowdProxy === "number") facts.push(`crowds ${Math.round(fp.crowdProxy)} of 100`);
  else if (s.crowdProxy === "pending") notes.push("Crowds pending — checks again later");
  return { facts, notes };
}

/** Pick the journey and stop to start from, and see what it was like. */
export function TemplatePicker({ journeys, journey, template, cityById, fingerprint, month, onChange }: TemplatePickerProps) {
  const known = journeys.some((j) => j.id === template.journeyId);
  const { facts, notes } = summary(fingerprint, month);
  return (
    <Card className="plan-repeat-template" padding="md">
      <div className="plan-repeat-template-fields">
        <Field label="Start from">
          <Select value={template.journeyId} onChange={(e) => onChange({ journeyId: e.target.value, stopIndex: null })}>
            {!known && (
              <option value={template.journeyId} disabled>
                {journey?.title ?? "A trip that's no longer in your journal"}
              </option>
            )}
            {journeys.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title} · {MONTH_SHORT[monthOf(j.startDate) - 1]} {yearOf(j.startDate)}
              </option>
            ))}
          </Select>
        </Field>
        {journey && journey.stops.length > 1 && (
          <Field label="Stop">
            <Select
              value={template.stopIndex === null ? "" : String(template.stopIndex)}
              onChange={(e) => onChange({ journeyId: template.journeyId, stopIndex: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">Whole trip</option>
              {journey.stops.map((s, i) => (
                <option key={i} value={i}>
                  {cityById.get(s.cityId)?.name ?? s.cityId}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {(facts.length > 0 || notes.length > 0) && (
        <p className="plan-repeat-template-facts">
          {facts.length > 0 && <span className="plan-repeat-template-k">Your trip: </span>}
          {facts.join(" · ")}
          {notes.map((n) => (
            <span key={n} className="plan-repeat-template-note">
              {n}
            </span>
          ))}
        </p>
      )}
    </Card>
  );
}
