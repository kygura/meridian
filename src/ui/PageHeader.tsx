import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { IconArrowLeft } from "./icons";

// Page actions slot. A screen wraps its header and tab content in
// <PageActionsProvider>; the PageHeader inside it exposes its actions area, and any
// descendant renders <PageActions>…</PageActions> to put its primary action there.
// This lets a tab component own the header's primary action (Trips, Plan).

const SlotContext = createContext<{ target: HTMLElement | null; setTarget: (el: HTMLElement | null) => void } | null>(null);

export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={{ target, setTarget }}>{children}</SlotContext.Provider>;
}

/** Portals its children into the nearest PageHeader's action area. Renders nothing without one. */
export function PageActions({ children }: { children: ReactNode }) {
  const ctx = useContext(SlotContext);
  if (!ctx?.target) return null;
  return createPortal(children, ctx.target);
}

export interface PageHeaderProps {
  /** Small mono uppercase line above the title ("Journal · where you've been"). */
  kicker?: ReactNode;
  title: ReactNode;
  /** Muted line under the title. */
  subtitle?: ReactNode;
  /** Back link above the title for detail views: { label: "Trips", href: "#/trips" } or onClick. */
  back?: { label: string; href?: string; onClick?: () => void };
  /** Tabs or Segmented control under the title row. */
  tabs?: ReactNode;
  /** Buttons on the right of the title row. One primary at most. */
  actions?: ReactNode;
  className?: string;
}

/** Page title row: back link, title, actions (plus PageActions slot), then tabs. */
export function PageHeader({ kicker, title, subtitle, back, tabs, actions, className }: PageHeaderProps) {
  const ctx = useContext(SlotContext);
  return (
    <header className={cx("ui-pagehead", className)}>
      {back ? (
        back.href ? (
          <a className="ui-pagehead-back" href={back.href} onClick={back.onClick}>
            <IconArrowLeft size={16} />
            {back.label}
          </a>
        ) : (
          <button type="button" className="ui-pagehead-back" onClick={back.onClick}>
            <IconArrowLeft size={16} />
            {back.label}
          </button>
        )
      ) : null}
      <div className="ui-pagehead-titles">
        {kicker ? <p className="ui-pagehead-kicker kicker">{kicker}</p> : null}
        <div className="ui-pagehead-row">
          <h1 className="ui-pagehead-title">{title}</h1>
          <div className="ui-pagehead-actions">
            {actions}
            {ctx ? <span className="ui-pagehead-slot" ref={ctx.setTarget} /> : null}
          </div>
        </div>
        {subtitle ? <p className="ui-pagehead-sub">{subtitle}</p> : null}
      </div>
      {tabs ? <div className="ui-pagehead-tabs">{tabs}</div> : null}
    </header>
  );
}

export interface SectionHeaderProps {
  /** Id for the heading, so the section can use aria-labelledby. */
  id?: string;
  title: ReactNode;
  /** Short muted line after the title: a count, a summary, a source. */
  meta?: ReactNode;
  /** Small controls on the right: ghost buttons, icon buttons, a badge. */
  actions?: ReactNode;
  /** Heading level. Sections inside a page are h2 (default); inside a sheet, h3. */
  level?: 2 | 3;
  className?: string;
}

/**
 * The one section heading used across screens: mono uppercase label, optional
 * muted meta after it, small actions pushed to the right. Page titles own the
 * serif; sections never use it.
 */
export function SectionHeader({ id, title, meta, actions, level = 2, className }: SectionHeaderProps) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <div className={cx("ui-section-head", className)}>
      <div className="ui-section-titles">
        <H id={id} className="ui-section-title">
          {title}
        </H>
        {meta ? <span className="ui-section-meta">{meta}</span> : null}
      </div>
      {actions ? <div className="ui-section-actions">{actions}</div> : null}
    </div>
  );
}

export interface PageProps {
  children: ReactNode;
  /** "default" caps width at 1080px; "wide" uses the full content width. */
  width?: "default" | "wide";
  className?: string;
}

/** Scrollable content page with the standard max width and padding. */
export function Page({ children, width = "default", className }: PageProps) {
  return (
    <div className={cx("ui-page", width === "wide" && "ui-page--wide", className)}>
      <div className="ui-page-inner">{children}</div>
    </div>
  );
}
