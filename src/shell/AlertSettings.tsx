import { useCallback, useEffect, useState } from "react";
import { Button, toast, useJournalToken } from "../ui";
import { IconBell, IconCheck, IconSend } from "../ui/icons";
import {
  describeDeliveries,
  disablePush,
  enablePush,
  getPushState,
  listChannels,
  openNotices,
  sendTestAlert,
  type PushState,
} from "../lib/notices";
import type { NoticeChannelStatus } from "../types";

const PUSH_NOTE: Partial<Record<PushState, string>> = {
  unsupported: "Push isn't available in this browser. On iPhone, add Meridian to the Home Screen first.",
  "server-off": "Push needs VAPID keys on the server.",
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings.",
};

/** Settings › Alerts: which channels are set up, push for this device, and a test alert. */
export function AlertSettingsSection() {
  const { unlocked } = useJournalToken();
  const [channels, setChannels] = useState<NoticeChannelStatus[] | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"push" | "test" | null>(null);

  const load = useCallback(async () => {
    try {
      setFailed(false);
      const [list, state] = await Promise.all([listChannels(), getPushState().catch((): PushState => "unsupported")]);
      setChannels(list);
      setPush(state);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (unlocked) void load();
  }, [unlocked, load]);

  if (!unlocked) {
    return (
      <section className="shell-settings-section">
        <h3 className="shell-settings-heading">Alerts</h3>
        <p className="shell-settings-hint">Unlock your journal to set up alerts.</p>
      </section>
    );
  }

  const togglePush = async () => {
    setBusy("push");
    try {
      const next = push === "on" ? await disablePush() : await enablePush();
      setPush(next);
      if (next === "on") toast("Push is on for this device", { tone: "success" });
      else if (next === "denied") toast(PUSH_NOTE.denied!, { tone: "warning" });
      setChannels(await listChannels());
    } catch {
      toast("Couldn't change push. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const labels = Object.fromEntries((channels ?? []).map((c) => [c.id, c.label]));
      const { message, ok } = describeDeliveries(await sendTestAlert(), labels);
      toast(message, { tone: ok ? "success" : "warning", duration: 7000 });
    } catch {
      toast("Couldn't send the test alert. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Alerts</h3>
      <p className="shell-settings-hint">
        Every alert is kept in{" "}
        <button type="button" className="shell-settings-inline" onClick={openNotices}>
          Alerts
        </button>
        . These also send it to you:
      </p>
      {failed ? (
        <div className="shell-settings-row">
          <span className="shell-settings-hint">Couldn't load the channels.</span>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="shell-channels" aria-busy={channels === null}>
          {(channels ?? []).map((c) => (
            <li key={c.id} className="shell-channel" data-on={c.configured || undefined}>
              <span className="shell-channel-name">{c.label}</span>
              <span className="shell-channel-state">
                {c.configured ? (
                  <>
                    <IconCheck size={14} />
                    On{c.detail ? ` · ${c.detail}` : ""}
                  </>
                ) : (
                  (c.detail ?? "Not set up")
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {push && PUSH_NOTE[push] ? <p className="shell-settings-hint">{PUSH_NOTE[push]}</p> : null}
      <div className="shell-settings-row shell-settings-row--wrap">
        {push === "on" || push === "off" ? (
          <Button size="sm" icon={<IconBell size={16} />} loading={busy === "push"} disabled={busy !== null} onClick={() => void togglePush()}>
            {push === "on" ? "Turn off push here" : "Turn on push here"}
          </Button>
        ) : null}
        <Button size="sm" icon={<IconSend size={16} />} loading={busy === "test"} disabled={busy !== null || channels === null} onClick={() => void test()}>
          Send test alert
        </Button>
      </div>
    </section>
  );
}
