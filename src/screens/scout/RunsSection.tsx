import { Badge, Card, Disclosure, EmptyState, ErrorState, SectionHeader, Skeleton } from "../../ui";
import { IconClock, IconExternal } from "../../ui/icons";
import { formatShortDate } from "../../lib/rotation";
import { runKindLabel, runSummaryText, runTone, runTopText, timeAgo, vsMedianText, windowText } from "../../lib/atlasFormat";
import type { RunSummary, ScanHighlight } from "../../lib/atlasApi";
import type { Resource } from "./useScout";

function Highlight({ h }: { h: ScanHighlight }) {
  return (
    <li className="scout-hl">
      <div className="scout-hl-main">
        <span className="scout-hl-dest">{h.destination}</span>
        <span className="scout-muted num">{windowText({ from: h.departDate, to: h.returnDate })}</span>
      </div>
      <div className="scout-hl-price">
        <span className="num">{h.priceEur != null ? `${Math.round(h.priceEur)} EUR` : "No price"}</span>
        <span className="scout-muted">{vsMedianText(h.priceVsMedianPct)}</span>
      </div>
      <div className="scout-hl-flags">
        {h.baselineDeal && <Badge tone="success">Deal</Badge>}
        {h.opportunity && <Badge tone="accent">Opportunity</Badge>}
        <Badge tone={h.passed ? "neutral" : "warning"}>{h.passed ? "Passed" : "Failed gates"}</Badge>
        {h.bookingUrl && (
          <a className="scout-link scout-hl-book" href={h.bookingUrl} target="_blank" rel="noopener noreferrer">
            Book <IconExternal size={14} />
            <span className="sr-only"> {h.destination} (opens in a new tab)</span>
          </a>
        )}
      </div>
    </li>
  );
}

function Run({ run, open }: { run: RunSummary; open: boolean }) {
  const top = runTopText(run);
  const hl = run.highlights ?? [];
  return (
    <Card padding="sm" className="scout-run">
      <div className="scout-run-head">
        <Badge tone={runTone(run)}>{runKindLabel(run)}</Badge>
        {run.kind === "fire" && run.status && <Badge tone={run.status === "failed" ? "danger" : "success"}>{run.status === "failed" ? "Failed" : "Fired"}</Badge>}
        <time className="scout-muted num" dateTime={run.at} title={new Date(run.at).toLocaleString("en-GB")}>
          {timeAgo(run.at)}
        </time>
        {run.origin && <span className="scout-muted">from <span className="iata">{run.origin}</span></span>}
      </div>
      <p className="scout-run-text">{runSummaryText(run)}</p>
      {top && (
        <p className="scout-run-top">
          <span className="scout-label">Top result</span> {top}
        </p>
      )}
      {hl.length > 0 && (
        <Disclosure summary={`Best ${hl.length} ${hl.length === 1 ? "result" : "results"}`} defaultOpen={open}>
          <ul className="scout-hl-list">
            {hl.map((h) => (
              <Highlight key={h.flightId} h={h} />
            ))}
          </ul>
        </Disclosure>
      )}
    </Card>
  );
}

/** The last ten runs: scans with their best results, discoveries, and run requests from here. */
export function RunsSection({ runs }: { runs: Resource<RunSummary[]> }) {
  const list = runs.data;
  const firstWithResults = list?.findIndex((r) => (r.highlights?.length ?? 0) > 0) ?? -1;
  return (
    <section className="scout-section" aria-labelledby="scout-runs">
      <SectionHeader id="scout-runs" title="Runs" meta={list?.length ? `Last ${list.length}${list[0] ? `, newest ${formatShortDate(list[0].at.slice(0, 10))}` : ""}` : undefined} />
      {runs.error && !list ? (
        <ErrorState message={runs.error} onRetry={() => void runs.reload()} />
      ) : !list ? (
        <Card padding="sm">
          <Skeleton lines={3} />
        </Card>
      ) : list.length === 0 ? (
        <EmptyState icon={<IconClock />} title="No runs yet" description="Run Atlas from the button at the top, or wait for the scheduled run. Each run is listed here with what it found." />
      ) : (
        <ul className="scout-list">
          {list.map((r, i) => (
            <li key={r.id}>
              <Run run={r} open={i === firstWithResults} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
