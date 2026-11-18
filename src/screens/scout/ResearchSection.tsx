import { Button, Card, EmptyState, SectionHeader } from "../../ui";
import { IconCheck } from "../../ui/icons";
import { monthShort } from "../../lib/atlasFormat";
import type { ResearchNeed } from "../../lib/atlasApi";

/** Places and months the next research run will cover (no figure yet, or one older than the freshness limit). */
export function ResearchSection({ needs, canRun, busy, onRun }: { needs: ResearchNeed[]; canRun: boolean; busy: boolean; onRun: () => void }) {
  return (
    <section className="scout-section" aria-labelledby="scout-research">
      <SectionHeader
        id="scout-research"
        title="Needs research"
        meta={needs.length ? `${needs.length} ${needs.length === 1 ? "place" : "places"}` : undefined}
        actions={
          needs.length > 0 ? (
            <Button size="sm" variant="ghost" loading={busy} disabled={!canRun} title={canRun ? undefined : "Connect the routine to start runs from here."} onClick={onRun}>
              Run research
            </Button>
          ) : undefined
        }
      />
      {needs.length === 0 ? (
        <EmptyState icon={<IconCheck />} title="Nothing waiting" description="Every place on your wishlist has recent research for the months that matter." />
      ) : (
        <>
          <p className="scout-lede">The next research run checks quiet seasons, conditions and events for these months. Higher priority places come first.</p>
          <ul className="scout-list">
            {needs.map((n) => (
              <li key={n.cityId}>
                <Card padding="sm" className="scout-need">
                  <span className="scout-need-name">{n.name}</span>
                  <span className="scout-muted num">Priority {n.priority}</span>
                  <span className="scout-need-months">{n.months.map(monthShort).join(", ")}</span>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
