import { useCallback, useState } from "react";
import { Button, ErrorState, Page, PageHeader, Skeleton, UnlockCard, toast, useJournalToken, Card } from "../../ui";
import { IconSparkle } from "../../ui/icons";
import { JournalLockedError } from "../../lib/journalApi";
import { runAtlas, type RunMode, type TripIdea } from "../../lib/atlasApi";
import { RUN_MODE_LABEL, planThisText } from "../../lib/atlasFormat";
import { useScout } from "./useScout";
import { StatusStrip } from "./StatusStrip";
import { IdeasSection } from "./IdeasSection";
import { WishlistSection } from "./WishlistSection";
import { ResearchSection } from "./ResearchSection";
import { TripsSection } from "./TripsSection";
import { RunsSection } from "./RunsSection";
import { SettingsSection } from "./SettingsSection";
import "./scout.css";

/**
 * Route #/scout. What Atlas is doing and the controls to steer it: where it flies from, trip ideas,
 * the wishlist, research it still needs, the trips it planned, its runs and its settings (ADR 0020).
 */
export default function ScoutScreen() {
  const { token, unlocked } = useJournalToken();
  const scout = useScout(unlocked, token);
  const { context, runs, trips, config } = scout;
  const [mode, setMode] = useState<RunMode>("scan");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const configured = context.data?.routine.configured ?? false;

  /** Fire the routine and toast what the server recorded (fired, or failed with its reason). */
  const run = useCallback(
    async (m: RunMode, key: string, text?: string) => {
      setBusyKey(key);
      try {
        const r = await runAtlas(m, text);
        if (r.status === "failed") toast(`Atlas did not start. ${r.detail ?? "The routine did not accept the request."}`, { tone: "danger", duration: 8000 });
        else toast(`Atlas ${RUN_MODE_LABEL[m].toLowerCase()} started. It reports back when it finishes.`, { tone: "success" });
        void runs.reload(true);
        void context.reload(true);
      } catch (err) {
        if (!(err instanceof JournalLockedError)) toast(`Could not start Atlas. ${err instanceof Error ? err.message : ""}`.trim(), { tone: "danger" });
      } finally {
        setBusyKey(null);
      }
    },
    [runs, context]
  );

  const header = (
    <PageHeader
      kicker="Atlas · scouting for you"
      title="Scout"
      subtitle="What Atlas is looking at, and the controls to steer it."
      actions={
        unlocked ? (
          <Button
            variant="primary"
            icon={<IconSparkle size={16} />}
            loading={busyKey === "run"}
            disabled={!configured}
            title={configured ? undefined : "Set ATLAS_ROUTINE_FIRE_URL and ATLAS_ROUTINE_TOKEN on the server."}
            onClick={() => void run(mode, "run")}
          >
            Run Atlas now
          </Button>
        ) : undefined
      }
    />
  );

  if (!unlocked) {
    return (
      <Page>
        {header}
        <UnlockCard title="Sign in to see what Atlas is doing" />
      </Page>
    );
  }

  if (!context.data) {
    return (
      <Page>
        {header}
        {context.error ? (
          <ErrorState message={context.error} onRetry={() => void context.reload()} />
        ) : (
          <div className="scout-loading" aria-busy="true" aria-label="Loading Atlas">
            <StatusStrip context={null} mode={mode} onMode={setMode} />
            <Card>
              <Skeleton lines={4} />
            </Card>
          </div>
        )}
      </Page>
    );
  }

  const ctx = context.data;
  const nowMonth = Number(ctx.today.slice(5, 7));
  const plan = (idea: TripIdea) => void run("scan", `plan:${idea.window}:${idea.cityId}`, planThisText(idea));

  return (
    <Page>
      {header}
      <div className="scout">
        <StatusStrip context={ctx} mode={mode} onMode={setMode} />
        <IdeasSection context={ctx} canRun={configured} busyKey={busyKey} onPlan={plan} />
        <WishlistSection context={context} places={ctx.wishlist} nowMonth={nowMonth} />
        <ResearchSection needs={ctx.researchNeeded} canRun={configured} busy={busyKey === "research"} onRun={() => void run("research", "research")} />
        <TripsSection trips={trips} />
        <RunsSection runs={runs} />
        <SettingsSection config={config} />
      </div>
    </Page>
  );
}
