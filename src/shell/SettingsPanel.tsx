import { useRef, useState } from "react";
import { Button, Popover, Segmented, UnlockCard, toast, useJournalToken } from "../ui";
import { IconLock, IconMonitor, IconMoon, IconSettings, IconSun, IconUnlock, IconUpload } from "../ui/icons";
import { useMeridianStore } from "../store";
import { parseTripFile, serializeTrips } from "../lib/tripTransfer";
import { useThemeStore, type ThemePref } from "./theme";
import { NotionSection } from "./NotionSettings";

/** Export trips to a JSON file and import them back (trips otherwise live only in this browser). */
function TripTransferSection() {
  const trips = useMeridianStore((s) => s.trips);
  const importTrips = useMeridianStore((s) => s.importTrips);
  const fileInput = useRef<HTMLInputElement>(null);
  const userTrips = trips.filter((t) => t.origin !== "agent");

  const exportTrips = () => {
    const blob = new Blob([serializeTrips(userTrips)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meridian-trips-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { added, replaced } = importTrips(parseTripFile(await file.text()));
      const parts = [added && `${added} added`, replaced && `${replaced} updated`].filter(Boolean);
      toast(`Trips imported: ${parts.join(", ") || "nothing new"}`, { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't import trips", { tone: "danger" });
    }
  };

  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Trips</h3>
      <p className="shell-settings-note">Trips are saved in this browser. Move them with a file.</p>
      <div className="shell-settings-row">
        <Button size="sm" icon={<IconUpload size={16} />} onClick={() => fileInput.current?.click()}>
          Import
        </Button>
        <Button size="sm" onClick={exportTrips} disabled={userTrips.length === 0}>
          Export
        </Button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onFile} />
      </div>
    </section>
  );
}

/** Theme, trips file and sign-in settings. Used in the sidebar popover and the phone More sheet. */
export function SettingsPanel() {
  const pref = useThemeStore((s) => s.pref);
  const setPref = useThemeStore((s) => s.setPref);
  const { unlocked, clear } = useJournalToken();

  return (
    <div className="shell-settings">
      <section className="shell-settings-section">
        <h3 className="shell-settings-heading">Appearance</h3>
        <Segmented<ThemePref>
          label="Theme"
          block
          value={pref}
          onChange={setPref}
          options={[
            { value: "light", label: "Light", icon: <IconSun /> },
            { value: "dark", label: "Dark", icon: <IconMoon /> },
            { value: "system", label: "System", icon: <IconMonitor /> },
          ]}
        />
      </section>
      <TripTransferSection />
      {unlocked && <NotionSection />}
      <section className="shell-settings-section">
        <h3 className="shell-settings-heading">Account</h3>
        {unlocked ? (
          <div className="shell-settings-row">
            <span className="shell-settings-status">
              <IconUnlock size={16} />
              Signed in
            </span>
            <Button size="sm" icon={<IconLock size={16} />} onClick={clear}>
              Sign out
            </Button>
          </div>
        ) : (
          <UnlockCard compact title="Sign in" />
        )}
      </section>
    </div>
  );
}

/** Settings button at the sidebar foot with its popover. */
export function SettingsPopover() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="shell-nav-link shell-settings-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconSettings />
        <span>Settings</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="right-end" label="Settings" className="shell-settings-popover">
        <SettingsPanel />
      </Popover>
    </>
  );
}

