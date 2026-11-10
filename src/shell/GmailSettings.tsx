import "./bridges.css";
import { nudgeLayout } from "./layoutNudge";
import { useCallback, useEffect, useState } from "react";
import { Button, toast } from "../ui";
import { IconCheck } from "../ui/icons";
import { disconnectGmail, getGmailStatus, startGmailConnect, syncGmail, type GmailStatus } from "../lib/bridgesApi";
import { navigate } from "../lib/router";

/** Settings › Inbox: connect Gmail read-only so travel confirmations arrive in the Inbox by themselves. */
export function GmailSection() {
  const [s, setS] = useState<GmailStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const load = useCallback(() => getGmailStatus().then((v) => (setS(v), nudgeLayout())).catch(() => setS(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!s) return null;

  const run = async (what: NonNullable<typeof busy>, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work", { tone: "danger" });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const connect = () =>
    run("connect", async () => {
      const { url } = await startGmailConnect();
      window.location.assign(url); // Google's consent screen; it sends the browser back to the Inbox
    });
  const sync = () =>
    run("sync", async () => {
      const r = await syncGmail();
      toast(`Checked ${r.messages} messages: ${r.added} new in the Inbox${r.complete ? "" : ". Older mail is still to scan; sync again."}`, { tone: "success" });
    });
  const disconnect = () =>
    run("disconnect", async () => {
      await disconnectGmail();
      toast("Gmail disconnected", { tone: "success" });
    });

  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Inbox</h3>
      {!s.configured ? (
        <>
          <p className="shell-settings-note bridge-note">
            Gmail import needs a Google OAuth client. Set <code>{s.missing.join(", ")}</code> on the server
            {s.missing.includes("GOOGLE_CLIENT_ID") ? ` and register ${s.redirectUri} as its redirect URI` : ""}.
          </p>
          <p className="bridge-muted">
            Until then, upload a <code>.eml</code> or <code>.mbox</code> file in the{" "}
            <a href="#/inbox" onClick={() => navigate({ view: "inbox" })}>
              Inbox
            </a>
            . It reads the same confirmations.
          </p>
        </>
      ) : s.connected ? (
        <>
          <span className="shell-settings-status">
            <IconCheck size={16} />
            {s.account ?? "Connected"}
          </span>
          <p className="bridge-muted">
            Read-only. Only dates, places and prices are kept, never the messages.
            {s.lastSync ? ` Last checked ${new Date(s.lastSync.at).toLocaleString()}: ${s.lastSync.messages} messages, ${s.lastSync.added} new.` : " Not checked yet."}
            {s.lastSync && !s.lastSync.complete && s.lastSync.mode === "backfill" ? " Older mail is still being scanned." : ""}
          </p>
          {s.lastSync?.error && <p className="bridge-error">{s.lastSync.error}</p>}
          <div className="shell-settings-row">
            <Button size="sm" loading={busy === "sync"} onClick={sync}>
              Check now
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "disconnect"} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="shell-settings-note bridge-note">Connect Gmail (read-only) to find flights, stays, trains and tickets in your mail. Confirmations land in the Inbox for review.</p>
          <div className="shell-settings-row">
            <Button size="sm" loading={busy === "connect"} onClick={connect}>
              Connect Gmail
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
