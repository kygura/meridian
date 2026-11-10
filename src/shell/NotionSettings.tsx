import "./bridges.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, CitySearch, Disclosure, Field, Input, Sheet, toast } from "../ui";
import {
  applyNotion,
  getNotionStatus,
  previewNotion,
  resolveNotionReview,
  saveNotionConfig,
  writeBackNotion,
  type NotionPlan,
  type NotionSource,
  type NotionStatus,
  type WindowView,
} from "../lib/bridgesApi";
import { JournalLockedError } from "../lib/journalApi";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthSpanText = (m: { start: number; end: number }): string => (m.start === m.end ? MONTHS[m.start - 1] : `${MONTHS[m.start - 1]} to ${MONTHS[m.end - 1]}`);
const windowText = (w: WindowView): string => `${w.kind} ${monthSpanText(w.months)}${w.reason ? ` (${w.reason})` : ""}`;

const REASON: Record<string, string> = { "no-match": "No match", ambiguous: "Ambiguous", compound: "Several places", "bad-dates": "No dates", "bad-kind": "Unknown season" };

const readText = (f: File) => f.text();

/** Settings section: pull the owner's seasons and place research from Notion into the rotation, after a preview. */
export function NotionSection() {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => getNotionStatus().then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;
  const ready = status.tokenSet && (status.resolved.seasonsDb || status.resolved.researchDb || status.resolved.researchPage);
  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Notion</h3>
      <p className="shell-settings-note bridge-note">
        {ready
          ? status.lastRun
            ? `Last import ${new Date(status.lastRun.at).toLocaleDateString()}: ${status.pool} places in your pool.`
            : "Connected. Nothing imported yet."
          : "Bring in your seasons and place research. Set NOTION_TOKEN on the server, or upload a Notion export."}
      </p>
      {status.review.length > 0 && <Badge tone="warning">{status.review.length} to review</Badge>}
      <div className="shell-settings-row">
        <Button size="sm" onClick={() => setOpen(true)}>
          Import from Notion
        </Button>
      </div>
      {open && <NotionSheet status={status} onClose={() => setOpen(false)} onChanged={load} />}
    </section>
  );
}

function PlanView({ plan }: { plan: NotionPlan }) {
  const s = plan.summary;
  const nothing = !s.windowsAdded && !s.windowsUpdated && !s.windowsRemoved && !s.poolAdded && !s.poolUpdated && !s.poolRemoved;
  return (
    <div className="bridge-plan">
      <p className="bridge-sum">
        {nothing
          ? "Nothing to change: what you have already matches Notion."
          : [
              plan.covers.seasons && `Windows: ${s.windowsAdded} new, ${s.windowsUpdated} changed, ${s.windowsRemoved} removed`,
              plan.covers.research && `Place pool: ${s.poolAdded} new, ${s.poolUpdated} changed, ${s.poolRemoved} removed`,
            ]
              .filter(Boolean)
              .join(". ")}
      </p>
      {plan.places.length > 0 && (
        <ul className="bridge-diff">
          {plan.places.map((p) => (
            <li key={p.cityId}>
              <strong>{p.name}</strong>
              <span className="bridge-muted">{p.country}</span>
              <ul>
                {p.added.map((w) => (
                  <li key={`a${w.ref}`} className="bridge-add">+ {windowText(w)}</li>
                ))}
                {p.updated.map((u) => (
                  <li key={`u${u.after.ref}`} className="bridge-chg">
                    ~ {windowText(u.before)} becomes {windowText(u.after)}
                  </li>
                ))}
                {p.removed.map((w) => (
                  <li key={`r${w.ref}`} className="bridge-del">− {windowText(w)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {plan.pool && plan.pool.added.length + plan.pool.updated.length + plan.pool.removed.length > 0 && (
        <p className="bridge-muted">
          Pool: {[...plan.pool.added.map((p) => `+ ${p.cityName}`), ...plan.pool.updated.map((p) => `~ ${p.after.cityName}`), ...plan.pool.removed.map((p) => `− ${p.cityName}`)].join(", ")}
        </p>
      )}
    </div>
  );
}

function ReviewList({ items, onResolve }: { items: NotionPlan["review"]; onResolve: (key: string, cityIds: string[]) => void }) {
  if (!items.length) return null;
  return (
    <div className="bridge-review">
      <h4 className="bridge-h">Needs your call ({items.length})</h4>
      <p className="bridge-muted">Meridian never guesses a place. Pick the city each name stands for once, and it is remembered.</p>
      <ul>
        {items.map((r) => (
          <li key={r.key}>
            <div className="bridge-review-head">
              <strong>{r.label}</strong>
              <Badge tone="warning">{REASON[r.reason]}</Badge>
              <span className="bridge-muted">
                {r.count} {r.db === "seasons" ? "rows" : "entries"}
              </span>
            </div>
            <p className="bridge-muted">{r.detail}</p>
            {r.reason !== "bad-dates" && r.reason !== "bad-kind" && (
              <>
                <div className="bridge-chips">
                  {r.suggestions.map((c) => (
                    <Button key={c.cityId} size="sm" onClick={() => onResolve(r.key, [c.cityId])}>
                      {c.name}, {c.country}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => onResolve(r.key, [])}>
                    Ignore this name
                  </Button>
                </div>
                <CitySearch size="sm" placeholder="Search for another city" aria-label={`City for ${r.label}`} onPick={(c) => onResolve(r.key, [c.id])} />
              </>
            )}
            {(r.reason === "bad-dates" || r.reason === "bad-kind") && <p className="bridge-muted">Fix the row in Notion (or the property names below) and preview again.</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MappingFields({ status, onSaved }: { status: NotionStatus; onSaved: () => void }) {
  const [draft, setDraft] = useState(status.config);
  const set = (db: "seasons" | "research", k: string, v: string) => setDraft((d) => ({ ...d, [db]: { ...d[db], [k]: v } }));
  const save = async () => {
    try {
      await saveNotionConfig({
        seasonsDb: draft.seasonsDb ?? "",
        researchDb: draft.researchDb ?? "",
        researchPage: draft.researchPage ?? "",
        seasons: draft.seasons,
        research: draft.research,
        daily: draft.daily,
        writeBack: draft.writeBack,
      });
      toast("Notion settings saved", { tone: "success" });
      onSaved();
    } catch {
      toast("Couldn't save the Notion settings", { tone: "danger" });
    }
  };
  const text = (label: string, value: string | undefined, on: (v: string) => void, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input size="sm" value={value ?? ""} onChange={(e) => on(e.target.value)} />
    </Field>
  );
  return (
    <div className="bridge-fields">
      {text("Travel Seasons database", draft.seasonsDb, (v) => setDraft({ ...draft, seasonsDb: v }), "An id or the page link. Share it with your integration first.")}
      {text("Location Research database", draft.researchDb, (v) => setDraft({ ...draft, researchDb: v }))}
      {text("or Location Research page", draft.researchPage, (v) => setDraft({ ...draft, researchPage: v }), "A page with a score table and a paragraph per place.")}
      <Disclosure summary="Property names">
        <div className="bridge-fields">
          {Object.entries(draft.seasons).map(([k, v]) => (
            <Field key={`s${k}`} label={`Seasons: ${k}`}>
              <Input size="sm" value={v} onChange={(e) => set("seasons", k, e.target.value)} />
            </Field>
          ))}
          {Object.entries(draft.research).map(([k, v]) => (
            <Field key={`r${k}`} label={`Research: ${k}`}>
              <Input size="sm" value={v} onChange={(e) => set("research", k, e.target.value)} />
            </Field>
          ))}
        </div>
      </Disclosure>
      <label className="bridge-check">
        <input type="checkbox" checked={draft.daily} onChange={(e) => setDraft({ ...draft, daily: e.target.checked })} />
        Import automatically every day (without a preview)
      </label>
      <label className="bridge-check">
        <input type="checkbox" checked={draft.writeBack.enabled} disabled={!status.writeBackAllowed} onChange={(e) => setDraft({ ...draft, writeBack: { ...draft.writeBack, enabled: e.target.checked } })} />
        Write my rotation back to a Notion database
      </label>
      {!status.writeBackAllowed && <p className="bridge-muted">Write-back is off on this server. Set NOTION_WRITE_BACK=1 to allow it.</p>}
      {draft.writeBack.enabled && text("Database to write to", draft.writeBack.database, (v) => setDraft({ ...draft, writeBack: { ...draft.writeBack, database: v } }), "Needs Name (title), Dates (date), Status (select) and Place (text).")}
      <Button size="sm" onClick={save}>
        Save settings
      </Button>
    </div>
  );
}

function NotionSheet({ status, onClose, onChanged }: { status: NotionStatus; onClose: () => void; onChanged: () => void }) {
  const [source, setSource] = useState<NotionSource | null>(null);
  const [plan, setPlan] = useState<NotionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = useRef<HTMLInputElement>(null);

  const run = useCallback(async (src: NotionSource) => {
    setBusy(true);
    setError(null);
    try {
      setSource(src);
      setPlan((await previewNotion(src)).plan);
    } catch (e) {
      setPlan(null);
      setError(e instanceof JournalLockedError ? "Sign in first." : e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!list.length) return;
    const up: Extract<NotionSource, { kind: "upload" }> = { kind: "upload" };
    for (const f of list) {
      const body = await readText(f);
      const name = f.name.toLowerCase();
      if (name.endsWith(".md") || name.endsWith(".markdown")) up.researchMarkdown = body;
      else if (/season/i.test(name)) up.seasonsCsv = body;
      else up.researchCsv = body;
    }
    void run(up);
  };

  const apply = async () => {
    if (!source || !plan) return;
    setBusy(true);
    try {
      const r = await applyNotion(source, plan.digest);
      toast(`Imported: ${r.summary.windowsAdded + r.summary.windowsUpdated} windows, ${r.summary.poolAdded + r.summary.poolUpdated} places`, { tone: "success" });
      onChanged();
      await run(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (key: string, cityIds: string[]) => {
    await resolveNotionReview(key, cityIds).catch(() => toast("Couldn't save that choice", { tone: "danger" }));
    if (source) void run(source);
  };

  const writeBack = async () => {
    try {
      const r = await writeBackNotion();
      toast(`Notion: ${r.created} created, ${r.updated} updated`, { tone: "success" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Write-back failed", { tone: "danger" });
    }
  };

  const changes = plan ? plan.summary.windowsAdded + plan.summary.windowsUpdated + plan.summary.windowsRemoved + plan.summary.poolAdded + plan.summary.poolUpdated + plan.summary.poolRemoved : 0;
  return (
    <Sheet
      open
      onClose={onClose}
      title="Import from Notion"
      description="Your own seasons become personal windows in your rotation; your place research becomes a pool of candidates. Nothing changes until you apply."
      size="lg"
      desktop="center"
      footer={
        <>
          {status.config.writeBack.enabled && status.writeBackAllowed && (
            <Button variant="ghost" onClick={writeBack}>
              Write rotation to Notion
            </Button>
          )}
          <Button variant="primary" disabled={!plan || changes === 0} loading={busy} onClick={apply}>
            Apply {changes ? `${changes} changes` : ""}
          </Button>
        </>
      }
    >
      <div className="bridge-sheet">
        <div className="bridge-actions">
          <Button disabled={!status.tokenSet} loading={busy && source?.kind === "api"} onClick={() => run({ kind: "api" })}>
            Preview from Notion
          </Button>
          <Button onClick={() => files.current?.click()}>Preview an export file…</Button>
          <input ref={files} type="file" accept=".csv,.md,.markdown,text/csv,text/markdown" multiple hidden onChange={onFiles} />
        </div>
        {!status.tokenSet && <p className="bridge-muted">No NOTION_TOKEN on the server. Export Travel Seasons as CSV and Location Research as CSV or Markdown (Notion: ... menu, Export), and choose the files.</p>}
        {error && <p className="bridge-error" role="alert">{error}</p>}
        {plan && <PlanView plan={plan} />}
        {plan && <ReviewList items={plan.review} onResolve={resolve} />}
        <Disclosure summary="Connection and property names">
          <MappingFields status={status} onSaved={onChanged} />
        </Disclosure>
      </div>
    </Sheet>
  );
}
