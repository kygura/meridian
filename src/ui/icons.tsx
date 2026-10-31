import type { SVGProps } from "react";

// Hand-drawn inline icon set (DESIGN-v3.md §4): 24 viewBox, drawn at 20px, 1.75 stroke,
// round caps and joins, currentColor. Decorative by default (aria-hidden); pass
// `title` to give one an accessible name.

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  title?: string;
}

function make(name: string, body: React.ReactNode) {
  function Icon({ size = 20, title, strokeWidth = 1.75, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : true}
        role={title ? "img" : undefined}
        focusable="false"
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {body}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

export const IconMap = make("Map", <>
  <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" />
  <path d="M9 4v14M15 6v14" />
</>);

export const IconTrips = make("Trips", <>
  <rect x="3.5" y="7" width="17" height="12.5" rx="2" />
  <path d="M8.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V7M3.5 12.5h17" />
</>);

export const IconPlan = make("Plan", <>
  <path d="M5 20V5" />
  <path d="M5 5h11l-2 3.5 2 3.5H5" />
</>);

export const IconInbox = make("Inbox", <>
  <path d="M3.5 13.5 6 5.5h12l2.5 8V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-4.5Z" />
  <path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
</>);

export const IconWorld = make("World", <>
  <circle cx="12" cy="12" r="8.5" />
  <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z" />
</>);

export const IconAsk = make("Ask", <>
  <path d="M20 12a7.5 7.5 0 0 1-10.9 6.7L4.5 20l1.3-4A7.5 7.5 0 1 1 20 12Z" />
  <path d="M9 11h.01M12 11h.01M15 11h.01" strokeWidth={2.25} />
</>);

export const IconPlus = make("Plus", <path d="M12 5v14M5 12h14" />);
export const IconMinus = make("Minus", <path d="M5 12h14" />);

export const IconCopy = make("Copy", <>
  <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
  <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
</>);

export const IconSearch = make("Search", <>
  <circle cx="11" cy="11" r="6.5" />
  <path d="m20 20-4.2-4.2" />
</>);

export const IconClose = make("Close", <path d="M6 6l12 12M18 6 6 18" />);

export const IconChevronDown = make("ChevronDown", <path d="m6 9 6 6 6-6" />);
export const IconChevronUp = make("ChevronUp", <path d="m6 15 6-6 6 6" />);
export const IconChevronLeft = make("ChevronLeft", <path d="m15 6-6 6 6 6" />);
export const IconChevronRight = make("ChevronRight", <path d="m9 6 6 6-6 6" />);

export const IconSettings = make("Settings", <>
  <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
  <circle cx="16" cy="7" r="2" />
  <circle cx="10" cy="17" r="2" />
</>);

export const IconSun = make("Sun", <>
  <circle cx="12" cy="12" r="3.75" />
  <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1" />
</>);

export const IconMoon = make("Moon", <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" />);

export const IconMonitor = make("Monitor", <>
  <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
  <path d="M9 20h6M12 16v4" />
</>);

export const IconCalendar = make("Calendar", <>
  <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
  <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
</>);

export const IconPin = make("Pin", <>
  <path d="M12 20.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 1 1 13 0c0 4.9-6.5 10.5-6.5 10.5Z" />
  <circle cx="12" cy="10" r="2.25" />
</>);

export const IconPlane = make("Plane", <path transform="rotate(45 12 12)" d="M12 3c1 0 1.5 1 1.5 2.5V9l7.5 4.5v2l-7.5-2.5v4.5l2.5 2V21L12 20l-4 1v-1.5l2.5-2V13L3 15.5v-2L10.5 9V5.5C10.5 4 11 3 12 3Z" />);

export const IconBell = make("Bell", <>
  <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" />
  <path d="M10 20.5a2 2 0 0 0 4 0" />
</>);

export const IconUpload = make("Upload", <>
  <path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5" />
  <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" />
</>);

export const IconCheck = make("Check", <path d="m5 12.5 4.5 4.5L19 7.5" />);

export const IconTrash = make("Trash", <>
  <path d="M4.5 7h15M10 4h4M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  <path d="M10 11v5M14 11v5" />
</>);

export const IconEdit = make("Edit", <>
  <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z" />
  <path d="m14 8 2 2" />
</>);

export const IconDrag = make("Drag", <>
  <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.75} />
</>);

export const IconMore = make("More", <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.75} />);

export const IconLock = make("Lock", <>
  <rect x="5" y="10.5" width="14" height="10" rx="2" />
  <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
</>);

export const IconUnlock = make("Unlock", <>
  <rect x="5" y="10.5" width="14" height="10" rx="2" />
  <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
</>);

export const IconStar = make("Star", <path d="m12 4 2.5 5.1 5.6.8-4 4 .9 5.6L12 16.8l-5 2.7.9-5.6-4-4 5.6-.8L12 4Z" />);

export const IconExternal = make("External", <>
  <path d="M13.5 4.5h6v6M19.5 4.5l-8 8" />
  <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
</>);

export const IconFilter = make("Filter", <path d="M4 5.5h16l-6.2 7.2V19l-3.6-1.8v-4.5L4 5.5Z" />);

export const IconArrowRight = make("ArrowRight", <path d="M5 12h14M13 6l6 6-6 6" />);
export const IconArrowLeft = make("ArrowLeft", <path d="M19 12H5M11 6l-6 6 6 6" />);

export const IconRefresh = make("Refresh", <>
  <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9" />
  <path d="M19.5 4v5h-5" />
</>);

export const IconLayers = make("Layers", <>
  <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
  <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
</>);

export const IconInfo = make("Info", <>
  <circle cx="12" cy="12" r="8.5" />
  <path d="M12 11v5M12 8h.01" />
</>);

export const IconAlert = make("Alert", <>
  <path d="M12 4 21 19.5H3L12 4Z" />
  <path d="M12 10v4M12 17h.01" />
</>);

export const IconEye = make("Eye", <>
  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
  <circle cx="12" cy="12" r="2.75" />
</>);

export const IconEyeOff = make("EyeOff", <>
  <path d="M4 4l16 16" />
  <path d="M10 6c.6-.1 1.3-.2 2-.2 6 0 9.5 6.2 9.5 6.2a16 16 0 0 1-2.6 3.3M6.6 7.4A15.6 15.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.3-1" />
</>);

export const IconSparkle = make("Sparkle", <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2L12 3.5Z" />);

export const IconMenu = make("Menu", <path d="M4 7h16M4 12h16M4 17h16" />);

export const IconSend = make("Send", <path d="M4.5 12 20 4.5 15.5 20l-3.2-6.3L4.5 12ZM12.3 13.7 20 4.5" />);

export const IconClock = make("Clock", <>
  <circle cx="12" cy="12" r="8.5" />
  <path d="M12 7.5V12l3 2" />
</>);

export const IconLogo = make("Logo", <>
  <circle cx="12" cy="12" r="8.5" />
  <path d="M12 3.5v17M3.5 12h17" />
  <path d="M12 3.5c3 2.6 4.5 5.4 4.5 8.5S15 17.9 12 20.5" />
</>);

/** Every icon by name, for menus and stories. */
export const icons = {
  map: IconMap,
  trips: IconTrips,
  plan: IconPlan,
  inbox: IconInbox,
  world: IconWorld,
  ask: IconAsk,
  plus: IconPlus,
  minus: IconMinus,
  copy: IconCopy,
  search: IconSearch,
  close: IconClose,
  chevronDown: IconChevronDown,
  chevronUp: IconChevronUp,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  settings: IconSettings,
  sun: IconSun,
  moon: IconMoon,
  monitor: IconMonitor,
  calendar: IconCalendar,
  pin: IconPin,
  plane: IconPlane,
  bell: IconBell,
  upload: IconUpload,
  check: IconCheck,
  trash: IconTrash,
  edit: IconEdit,
  drag: IconDrag,
  more: IconMore,
  lock: IconLock,
  unlock: IconUnlock,
  star: IconStar,
  external: IconExternal,
  filter: IconFilter,
  arrowRight: IconArrowRight,
  arrowLeft: IconArrowLeft,
  refresh: IconRefresh,
  layers: IconLayers,
  info: IconInfo,
  alert: IconAlert,
  eye: IconEye,
  eyeOff: IconEyeOff,
  sparkle: IconSparkle,
  menu: IconMenu,
  send: IconSend,
  clock: IconClock,
  logo: IconLogo,
} as const;

export type IconName = keyof typeof icons;
export type IconComponent = (typeof icons)[IconName];
