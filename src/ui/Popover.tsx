import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { focusableIn, useLayer } from "./layers";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-end" | "right-start";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The trigger. Clicks on it do not count as outside clicks. */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  /** Accessible name for the popover region. */
  label: string;
  /** "dialog" (default) for interactive content, "tooltip"-like content can pass "group". */
  role?: "dialog" | "group" | "menu";
  /** Move focus into the popover on open (default true). */
  autoFocus?: boolean;
  className?: string;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;

/**
 * Floating panel anchored to a trigger. Closes on Esc and outside click, returns focus
 * to the trigger. Give the trigger aria-expanded and aria-haspopup="dialog".
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = "bottom-start",
  label,
  role = "dialog",
  autoFocus = true,
  className,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayer(open, onClose);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = 0;
      let left = 0;
      if (placement.startsWith("bottom")) top = a.bottom + GAP;
      else if (placement.startsWith("top")) top = a.top - h - GAP;
      if (placement.startsWith("right")) {
        left = a.right + GAP;
        top = placement === "right-end" ? a.bottom - h : a.top;
      } else left = placement.endsWith("end") ? a.right - w : a.left;
      // Flip vertically when it would leave the viewport.
      if (placement.startsWith("bottom") && top + h > window.innerHeight - MARGIN) top = a.top - h - GAP;
      if (placement.startsWith("top") && top < MARGIN) top = a.bottom + GAP;
      left = Math.min(Math.max(MARGIN, left), window.innerWidth - w - MARGIN);
      top = Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement, anchorRef]);

  // Outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose, anchorRef]);

  // Focus in, and back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (autoFocus) {
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el || el.contains(document.activeElement)) return;
        (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(el)[0] ?? el).focus({ preventScroll: true });
      });
    }
    return () => {
      const active = document.activeElement;
      if (anchor && (!active || active === document.body || ref.current?.contains(active))) anchor.focus({ preventScroll: true });
    };
  }, [open, autoFocus, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cx("ui-popover", className)}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body
  );
}
