import { useEffect } from "react";
import { useUIStore } from "./uiStore";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Global shortcuts. Escape is handled by the layer stack (src/ui/layers.ts), which
 * closes the topmost Sheet / Dialog / Popover / Ask panel.
 *   ⌘K / Ctrl+K  toggle Ask
 *   /            focus the visible element marked data-page-search
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUIStore.getState().toggleAsk();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        const el = Array.from(document.querySelectorAll<HTMLElement>("[data-page-search]")).find(
          (n) => n.getClientRects().length > 0
        );
        if (el) {
          e.preventDefault();
          el.focus();
          if (el instanceof HTMLInputElement) el.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
