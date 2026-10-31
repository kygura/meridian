import { useEffect, useRef, type RefObject } from "react";

// Layer stack for Escape handling (one global listener). Every Sheet, Dialog,
// Popover, and the docked Ask panel registers while open; Escape closes only the
// topmost one. A handler that wants Escape for itself (e.g. an open combobox list)
// calls e.preventDefault() or stopPropagation() and the stack ignores the event.

interface Layer {
  id: number;
  close: () => void;
}

const stack: Layer[] = [];
let nextId = 1;
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

function ensureListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown);
  listening = true;
}

/** True when any layer is open. */
export function hasOpenLayer(): boolean {
  return stack.length > 0;
}

/** Register a closable layer while `open`. Escape calls the latest `onClose`. */
export function useLayer(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    ensureListener();
    const layer: Layer = { id: nextId++, close: () => closeRef.current() };
    stack.push(layer);
    return () => {
      const i = stack.findIndex((l) => l.id === layer.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0
  );
}

/**
 * Trap Tab inside `ref` while active. On activation focuses `initialFocus`, else the
 * first [data-autofocus] element, else the first focusable, else the container.
 * Restores focus to the previously focused element on deactivation.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocus?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;

    const raf = requestAnimationFrame(() => {
      if (root.contains(document.activeElement)) return;
      const target =
        initialFocus?.current ??
        root.querySelector<HTMLElement>("[data-autofocus]") ??
        focusableIn(root)[0] ??
        root;
      target.focus({ preventScroll: true });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref, initialFocus]);
}
