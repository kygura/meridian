import { useId, useRef, useState, type ReactNode, type RefObject, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { useFocusTrap, useLayer } from "./layers";
import { IconButton } from "./Button";
import { IconClose } from "./icons";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading; also the dialog's accessible name. */
  title: ReactNode;
  /** Muted line under the title. */
  description?: ReactNode;
  /** Desktop (>= 900px) placement. Phones always get a bottom sheet. Default "side". */
  desktop?: "side" | "center";
  /** Desktop width: sm 360, md 440, lg 560 (side) / 480, 600, 760 (center). Default md. */
  size?: "sm" | "md" | "lg";
  /** Sticky footer, usually the save button. */
  footer?: ReactNode;
  /** Extra header content right of the title (e.g. a Badge). */
  headerExtra?: ReactNode;
  /**
   * Modal (default): scrim, focus trap, page behind is inert to clicks.
   * Non-modal: no scrim, no trap; the page behind stays usable (city panel over the map).
   */
  modal?: boolean;
  /** Element to focus on open. Defaults to [data-autofocus], then the first focusable. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

const DISMISS_PX = 96;

/**
 * Bottom sheet on phones (drag the handle down to close); right side panel or centered
 * panel on desktop. Esc closes the topmost sheet. Rendered in a portal.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  desktop = "side",
  size = "md",
  footer,
  headerExtra,
  modal = true,
  initialFocus,
  className,
  children,
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);

  useLayer(open, onClose);
  useFocusTrap(panel, open && modal, initialFocus);

  if (!open) return null;

  const onHandleDown = (e: RPointerEvent) => {
    dragStart.current = e.clientY;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: RPointerEvent) => {
    if (dragStart.current === null) return;
    setDrag(Math.max(0, e.clientY - dragStart.current));
  };
  const onHandleUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > DISMISS_PX) onClose();
    setDrag(0);
  };

  return createPortal(
    <div className={cx("ui-sheet-root", modal ? "ui-sheet-root--modal" : "ui-sheet-root--modeless")} data-desktop={desktop}>
      {modal ? <div className="ui-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <div
        ref={panel}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx("ui-sheet", `ui-sheet--${size}`, className)}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        <div
          className="ui-sheet-handle"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          aria-hidden="true"
        >
          <span />
        </div>
        <header className="ui-sheet-header">
          <div className="ui-sheet-titles">
            <h2 id={titleId} className="ui-sheet-title">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="ui-sheet-desc">
                {description}
              </p>
            ) : null}
          </div>
          {headerExtra}
          <IconButton label="Close" icon={<IconClose />} onClick={onClose} />
        </header>
        <div className="ui-sheet-body">{children}</div>
        {footer ? <footer className="ui-sheet-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, right-aligned. Put the confirming action last. */
  footer?: ReactNode;
  /** "alertdialog" for destructive confirmations. */
  role?: "dialog" | "alertdialog";
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  className?: string;
}

/** Small centered modal for confirmations. Use Sheet for forms. */
export function Dialog({ open, onClose, title, description, footer, role = "dialog", initialFocus, children, className }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useLayer(open, onClose);
  useFocusTrap(panel, open, initialFocus);
  if (!open) return null;
  return createPortal(
    <div className="ui-dialog-root">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx("ui-dialog", className)}
      >
        <h2 id={titleId} className="ui-dialog-title">
          {title}
        </h2>
        {description ? (
          <p id={descId} className="ui-dialog-desc">
            {description}
          </p>
        ) : null}
        {children ? <div className="ui-dialog-body">{children}</div> : null}
        {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}
