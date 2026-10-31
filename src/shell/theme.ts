import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useMeridianStore } from "../store";
import { useMediaQuery } from "../ui/useMediaQuery";

// Theme lives in the shell (not in useMeridianStore). The preference is
// light / dark / system, persisted under localStorage "meridian.theme" (index.html
// reads the same key before first paint). The shell writes it to
// html[data-theme]; tokens.css does the rest. The resolved value is mirrored into
// useMeridianStore.theme for older code that still reads it.

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeState {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      pref: "light",
      setPref: (pref) => set({ pref }),
    }),
    { name: "meridian.theme" }
  )
);

/** The theme actually showing: the preference, or the OS setting for "system". */
export function useResolvedTheme(): ResolvedTheme {
  const pref = useThemeStore((s) => s.pref);
  const osDark = useMediaQuery("(prefers-color-scheme: dark)");
  return pref === "system" ? (osDark ? "dark" : "light") : pref;
}

/** Mounted once by AppShell: writes data-theme and mirrors the resolved theme. */
export function useApplyTheme(): void {
  const pref = useThemeStore((s) => s.pref);
  const resolved = useResolvedTheme();
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", pref);
  }, [pref]);
  useEffect(() => {
    if (useMeridianStore.getState().theme !== resolved) useMeridianStore.setState({ theme: resolved });
  }, [resolved]);
}
