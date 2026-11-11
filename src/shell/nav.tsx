import type { ReactNode } from "react";
import type { Route, View } from "../lib/router";
import { IconCalendar, IconInbox, IconMap, IconPlan, IconTrips, IconWorld } from "../ui/icons";

export interface NavItem {
  view: View;
  label: string;
  href: string;
  icon: ReactNode;
  /** Which nav badge to show. */
  badge?: "inbox" | "alerts";
}

export const NAV_ITEMS: NavItem[] = [
  { view: "map", label: "Map", href: "#/", icon: <IconMap /> },
  { view: "trips", label: "Trips", href: "#/trips", icon: <IconTrips /> },
  { view: "plan", label: "Plan", href: "#/plan/when", icon: <IconPlan />, badge: "alerts" },
  { view: "inbox", label: "Inbox", href: "#/inbox", icon: <IconInbox />, badge: "inbox" },
  { view: "world", label: "World", href: "#/world", icon: <IconWorld /> },
  { view: "rotation", label: "Rotation", href: "#/rotation", icon: <IconCalendar /> },
];

export function isActive(item: NavItem, route: Route): boolean {
  return item.view === route.view;
}
