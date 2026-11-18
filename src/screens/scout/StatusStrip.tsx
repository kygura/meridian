import { Badge, Card, Field, SectionHeader, Select, Skeleton, Stat } from "../../ui";
import { IconInfo } from "../../ui/icons";
import { formatShortDate } from "../../lib/rotation";
import { ORIGIN_TEXT, RUN_MODE_HINT, runKindLabel, runSummaryText, runTone, timeAgo, windowText } from "../../lib/atlasFormat";
import type { AtlasContext, RunMode } from "../../lib/atlasApi";

const MODE_OPTIONS = [
  { value: "scan", label: "Scan: fares and trips" },
  { value: "discover", label: "Discover: new places" },
  { value: "research", label: "Research: season" },
];

/** Where Atlas flies from, the two search windows and the last run. */
export function StatusStrip({ context, mode, onMode }: { context: AtlasContext | null; mode: RunMode; onMode: (m: RunMode) => void }) {
  if (!context) {
    return (
      <section className="scout-section" aria-label="Atlas status">
        <SectionHeader title="Atlas now" />
        <div className="scout-stats">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} padding="sm">
              <Skeleton lines={3} />
            </Card>
          ))}
        </div>
      </section>
    );
  }
  const { origin, windows, config, lastRuns, routine } = context;
  const last = lastRuns[0];
  return (
    <section className="scout-section" aria-labelledby="scout-now">
      <SectionHeader id="scout-now" title="Atlas now" meta={formatShortDate(context.today)} />
      <div className="scout-stats">
        <Stat
          label="Flying from"
          value={origin.name}
          hint={
            <>
              <span className="iata">{origin.iata ?? "No airport"}</span>
              {origin.country ? `, ${origin.country}` : ""}. Found from {ORIGIN_TEXT[origin.source]}.
            </>
          }
        />
        <Stat label="Window A" value={<span className="scout-stat-dates">{windowText(windows.a)}</span>} hint={`Short notice, ${config.windows.a.minDays} to ${config.windows.a.maxDays} days out`} />
        <Stat label="Window B" value={<span className="scout-stat-dates">{windowText(windows.b)}</span>} hint={`Planned ahead, ${config.windows.b.minDays} to ${config.windows.b.maxDays} days out`} />
        <Stat
          label="Last run"
          value={last ? timeAgo(last.at) : "None yet"}
          hint={
            last ? (
              <>
                <Badge tone={runTone(last)}>{runKindLabel(last)}</Badge> {runSummaryText(last)}
              </>
            ) : (
              "Atlas has not reported a run."
            )
          }
        />
      </div>
      <div className="scout-mode">
        <Field label="Run mode" hint={RUN_MODE_HINT[mode]}>
          <Select value={mode} options={MODE_OPTIONS} onChange={(e) => onMode(e.target.value as RunMode)} />
        </Field>
      </div>
      {!routine.configured && (
      <p className="scout-note">
        <IconInfo size={16} />
        {(
          <span>
            The routine is not connected. Set <code>ATLAS_ROUTINE_FIRE_URL</code> and <code>ATLAS_ROUTINE_TOKEN</code> on the server from the routine&apos;s API trigger to start runs from here.
          </span>
        )}
      </p>
      )}
    </section>
  );
}
