// 极简线条 SVG 图标（tokens 规则：无 emoji，仅极简 SVG；stroke 用 currentColor 便于 tint）
const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const IconUser = (p) => (
  <svg {...base} {...p}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export const IconLock = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const IconAvatar = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="10" r="1" fill="currentColor" stroke="none" />
    <path d="M8.5 15a5 5 0 0 0 7 0" />
  </svg>
);

export const IconDoc = (p) => (
  <svg {...base} {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
  </svg>
);

export const IconDownload = (p) => (
  <svg {...base} {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export const IconInfo = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-5M12 8h.01" />
  </svg>
);

export const IconLogout = (p) => (
  <svg {...base} {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export const IconChart = (p) => (
  <svg {...base} {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-6 3 3 5-8" />
  </svg>
);

export const IconHistory = (p) => (
  <svg {...base} {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 3" />
  </svg>
);

export const IconCode = (p) => (
  <svg {...base} {...p}>
    <path d="M8 6l-5 6 5 6" />
    <path d="M16 6l5 6-5 6" />
  </svg>
);

// 拖拽手柄（三横线，列表排序用）
export const IconGrip = (p) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

// 下折箭头（折叠卡片展开态随 .up 旋转 180°）
export const IconChevron = (p) => (
  <svg {...base} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
