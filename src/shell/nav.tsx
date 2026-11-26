import type { ReactNode } from "react";
import type { Route, View } from "../lib/router";
import { IconCalendar, IconInbox, IconMap, IconPin, IconPlan, IconSparkle, IconTrips, IconWorld } from "../ui/icons";

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
  { view: "scout", label: "Scout", href: "#/scout", icon: <IconSparkle /> },
  { view: "inbox", label: "Inbox", href: "#/inbox", icon: <IconInbox />, badge: "inbox" },
  { view: "world", label: "World", href: "#/world", icon: <IconWorld /> },
  { view: "rotation", label: "Rotation", href: "#/rotation", icon: <IconCalendar /> },
  { view: "locales", label: "Locales", href: "#/locales", icon: <IconPin /> },
];

export function isActive(item: NavItem, route: Route): boolean {
  return item.view === route.view;
}
