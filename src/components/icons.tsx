/** Minimal inline stroke icons (24px grid, currentColor). Decorative: aria-hidden. */
import type { JSX, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export const IconArrowRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconPlus = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconMinus = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M5 12h14" />
  </svg>
);
export const IconArrowUp = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const IconChevronRight = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const IconClose = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconCheck = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconAlert = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5v.01" />
  </svg>
);
export const IconInfo = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </svg>
);
export const IconRefresh = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" />
  </svg>
);
export const IconLayers = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
);
export const IconLock = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </svg>
);
export const IconMail = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
  </svg>
);
export const IconPerson = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);
export const IconSearch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);
export const IconBox = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z" />
    <path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" />
  </svg>
);
export const IconTag = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9-9-9z" />
    <circle cx="8" cy="8" r="1.5" />
  </svg>
);
export const IconCalendar = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
export const IconPin = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </svg>
);
export const IconDoc = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 16h6" />
  </svg>
);
export const IconCart = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 4h2.5l2.2 11h10.6l2-8H6.6" />
    <circle cx="9.5" cy="19" r="1.3" />
    <circle cx="17" cy="19" r="1.3" />
  </svg>
);
export const IconShield = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l7.5 3v6c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6z" />
  </svg>
);
export const IconSpark = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
  </svg>
);
export const IconBolt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12l1-8z" />
  </svg>
);
export const IconDrop = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10 12 3 12 3z" />
  </svg>
);
export const IconTv = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4.5" width="19" height="12.5" rx="2" />
    <path d="M8 20.5h8M12 17v3.5" />
  </svg>
);
export const IconLeaf = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 19c0-8 5-13 15-14-1 10-6 15-14 15" />
    <path d="M5 19c3-4 6-7 10-9" />
  </svg>
);
export const IconHome = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M6 9.5V20h12V9.5" />
    <path d="M10 20v-5h4v5" />
  </svg>
);
export const IconChat = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 5.5h16v10H9l-5 4z" />
  </svg>
);
export const IconClock = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
  </svg>
);
export const IconSignOut = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </svg>
);

const BUSINESS_ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  "volt-supply": IconBolt,
  "flowline-plumbing": IconDrop,
  "mountpro-tv": IconTv,
  "greenstripe-lawn": IconLeaf,
  "brightnest-cleaning": IconHome,
};

export function BusinessIcon({ id, ...p }: IconProps & { id: string }) {
  const Icon = BUSINESS_ICONS[id] ?? IconChat;
  return <Icon {...p} />;
}
