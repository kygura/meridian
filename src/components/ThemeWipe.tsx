import { useEffect, useRef } from "react";
import { useMeridianStore } from "../store";

export default function ThemeWipe() {
  const { themeWipe, clearThemeWipe } = useMeridianStore();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeWipe?.active) return;

    const el = overlayRef.current;
    if (!el) return;

    // Calculate the max radius needed to cover the entire viewport from the origin point
    const maxDim = Math.max(
      themeWipe.x,
      themeWipe.y,
      window.innerWidth - themeWipe.x,
      window.innerHeight - themeWipe.y
    );
    const radius = Math.ceil(Math.sqrt(2 * maxDim * maxDim));

    // Phase 1: expand the circle (new theme color fills outward)
    el.style.setProperty("--wipe-x", `${themeWipe.x}px`);
    el.style.setProperty("--wipe-y", `${themeWipe.y}px`);
    el.style.setProperty("--wipe-r", `${radius}px`);
    el.dataset.next = themeWipe.next;

    // Force reflow so the initial state is applied
    void el.offsetWidth;

    el.classList.add("wipe-expanding");

    const expandDone = () => {
      // Phase 2: theme switch happens at the midpoint
      document.documentElement.setAttribute("data-theme", themeWipe.next);
      useMeridianStore.setState({ theme: themeWipe.next });

      // Phase 3: fade out the overlay
      el.classList.remove("wipe-expanding");
      el.classList.add("wipe-fading");

      const fadeDone = () => {
        el.classList.remove("wipe-fading");
        el.dataset.next = "";
        clearThemeWipe();
      };
      el.addEventListener("transitionend", fadeDone, { once: true });
      // Fallback in case transitionend doesn't fire
      setTimeout(fadeDone, 600);
    };

    el.addEventListener("transitionend", expandDone, { once: true });
    // Fallback
    setTimeout(expandDone, 700);
  }, [themeWipe, clearThemeWipe]);

  if (!themeWipe?.active) return null;

  return <div ref={overlayRef} className="theme-wipe-overlay" />;
}
