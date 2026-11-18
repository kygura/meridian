import { Badge, Button, Card, EmptyState, SectionHeader } from "../../ui";
import { IconArrowRight, IconSparkle } from "../../ui/icons";
import { openCity } from "../../shell/uiStore";
import { planThisText, windowText } from "../../lib/atlasFormat";
import type { AtlasContext, TripIdea } from "../../lib/atlasApi";

interface Props {
  context: AtlasContext;
  canRun: boolean;
  busyKey: string | null;
  onPlan: (idea: TripIdea) => void;
}

/** Wishlist places ranked for each search window, from where the owner is. */
export function IdeasSection({ context, canRun, busyKey, onPlan }: Props) {
  const groups = [
    { key: "a" as const, title: "Window A", label: "Short notice", win: context.windows.a },
    { key: "b" as const, title: "Window B", label: "Planned ahead", win: context.windows.b },
  ];
  const total = context.ideas.length;
  return (
    <section className="scout-section" aria-labelledby="scout-ideas">
      <SectionHeader id="scout-ideas" title="Trip ideas" meta={total ? `${total} ranked from your places` : undefined} />
      {total === 0 ? (
        <EmptyState
          icon={<IconSparkle />}
          title="No trip ideas yet"
          description="Ideas come from the places on your wishlist, ranked for each window by Comfort Index, crowds, your priority and distance. Add a place below to get started."
        />
      ) : (
        <div className="scout-ideas">
          {groups.map((g) => {
            const ideas = context.ideas.filter((i) => i.window === g.key);
            return (
              <div key={g.key} className="scout-idea-group">
                <h3 className="scout-h3">
                  {g.title}: {g.label}
                  <span className="scout-h3-meta">{windowText(g.win)}</span>
                </h3>
                {ideas.length === 0 ? (
                  <p className="scout-muted">Nothing on your wishlist suits these dates. Places you avoid in every month of the window are left out.</p>
                ) : (
                  <ol className="scout-list">
                    {ideas.map((idea, i) => {
                      const key = `${idea.window}:${idea.cityId}`;
                      return (
                        <li key={key}>
                          <Card className="scout-idea" padding="sm">
                            <span className="scout-idea-rank num" aria-hidden="true">
                              {i + 1}
                            </span>
                            <div className="scout-idea-main">
                              <div className="scout-idea-title">
                                <button type="button" className="scout-link" onClick={() => openCity(idea.cityId)}>
                                  {idea.name}
                                </button>
                                <span className="scout-muted">{idea.country}</span>
                                {idea.iata && <span className="iata">{idea.iata}</span>}
                                <Badge tone="accent" title="Score out of 100">
                                  <span className="num">{Math.round(idea.score)}</span>
                                </Badge>
                                {idea.km != null && <span className="scout-muted num">{idea.km.toLocaleString("en")} km away</span>}
                              </div>
                              {idea.reasons.filter((r) => !r.endsWith("km away")).length > 0 && (
                                <ul className="scout-reasons">
                                  {idea.reasons.filter((r) => !r.endsWith("km away")).map((r) => (
                                    <li key={r}>{r}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div className="scout-idea-actions">
                              <Button size="sm" variant="ghost" onClick={() => openCity(idea.cityId)}>
                                View city
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                iconRight={<IconArrowRight size={16} />}
                                loading={busyKey === `plan:${key}`}
                                disabled={!canRun}
                                title={canRun ? planThisText(idea) : "Connect the routine to start runs from here."}
                                onClick={() => onPlan(idea)}
                              >
                                Plan this
                              </Button>
                            </div>
                          </Card>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
