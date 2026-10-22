import type { SVGProps } from "react";

// Icons of the design spec (.design/*.dc.html), stroke-based, currentColor.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...rest,
  };
}

export const IconPlus = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconSend = (p: IconProps) => (
  <svg {...base({ size: 18, strokeWidth: 2.2, ...p })}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconSearch = (p: IconProps) => (
  <svg {...base({ size: 12, strokeWidth: 2.2, ...p })}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);
export const IconBook = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 5h6v14H4zM14 5h6v14h-6z" />
  </svg>
);
export const IconGear = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
  </svg>
);
export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </svg>
);
export const IconUp = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 11v9H4v-9h3zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7" />
  </svg>
);
export const IconDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M17 13V4h3v9h-3zM17 13l-4 8c-1.5 0-2.5-1-2.5-2.5V15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17" />
  </svg>
);
export const IconInfo = (p: IconProps) => (
  <svg {...base({ size: 20, strokeWidth: 2, ...p })}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </svg>
);
export const IconWarning = (p: IconProps) => (
  <svg {...base({ size: 18, strokeWidth: 2, ...p })}>
    <path d="M12 3l9 16H3L12 3z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);
export const IconExternal = (p: IconProps) => (
  <svg {...base({ size: 14, strokeWidth: 2, ...p })}>
    <path d="M7 17L17 7M9 7h8v8" />
  </svg>
);
export const IconMenu = (p: IconProps) => (
  <svg {...base({ size: 18, strokeWidth: 2, ...p })}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const IconClose = (p: IconProps) => (
  <svg {...base({ size: 18, strokeWidth: 2, ...p })}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconCheck = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M5 12l5 5 9-10" />
  </svg>
);
