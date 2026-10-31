import { useRef, useState } from "react";
import { Button, Popover, Segmented, UnlockCard, useJournalToken } from "../ui";
import { IconLock, IconMonitor, IconMoon, IconSettings, IconSun, IconUnlock } from "../ui/icons";
import { useThemeStore, type ThemePref } from "./theme";

/** Theme and journal settings. Used in the sidebar popover and the phone More sheet. */
export function SettingsPanel() {
  const pref = useThemeStore((s) => s.pref);
  const setPref = useThemeStore((s) => s.setPref);
  const { unlocked, token, clear } = useJournalToken();

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
      <section className="shell-settings-section">
        <h3 className="shell-settings-heading">Journal</h3>
        {unlocked ? (
          <div className="shell-settings-row">
            <span className="shell-settings-status">
              <IconUnlock size={16} />
              Unlocked in this browser
            </span>
            <Button size="sm" icon={<IconLock size={16} />} onClick={clear}>
              Lock
            </Button>
          </div>
        ) : (
          <>
            {token ? <p className="shell-settings-note">The saved token was rejected. Enter it again.</p> : null}
            <UnlockCard compact title="Unlock your journal" />
          </>
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

