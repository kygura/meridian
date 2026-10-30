import type { Provenance } from "../../types";

const SOURCE: Record<Provenance["source"], string> = {
  manual: "MANUAL",
  booking: "BOOKING",
  gmail: "GMAIL",
  jsonld: "JSON-LD",
  calendar: "CALENDAR",
  timeline: "TIMELINE",
  photo: "PHOTO",
};

/** Where an item came from. A MANUAL + high chip is hidden so hand-logged journeys stay calm. */
export default function ProvenanceChip({ provenance }: { provenance?: Provenance }) {
  if (!provenance) return null;
  const { source, confidence } = provenance;
  if (source === "manual" && confidence === "high") return null;
  const tone = confidence === "medium" ? "med" : confidence === "low" ? "low" : "";
  const title = [provenance.sourceRef, provenance.importedAt && `imported ${provenance.importedAt.slice(0, 10)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className={`bk-badge jr-chip ${tone}`}
      role="img"
      title={title || undefined}
      aria-label={`Imported from ${SOURCE[source].toLowerCase()}${tone ? `, ${confidence} confidence` : ""}`}
    >
      {SOURCE[source]}
      {confidence === "medium" && " · MED"}
      {confidence === "low" && " · LOW"}
    </span>
  );
}
