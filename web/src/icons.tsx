// 图标集：内联 SVG，路径照抄 prototype/index.html（lucide 风格）
// 统一 props：size 走 className，颜色继承 currentColor

type P = { className?: string };

const base = (className = "h-5 w-5") => ({
  className,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

/** 棱镜品牌标（填充型，非描边） */
export function Prism({ className = "h-6 w-6" }: P) {
  return (
    <svg className={`prism ${className}`} viewBox="0 0 24 24" fill="none">
      <path d="M12 3 L20 18 H4 Z" fill="var(--accent)" />
      <path d="M12 3 L16.5 12" stroke="var(--warm)" strokeWidth="1.2" />
      <path d="M12 3 L7.5 12" stroke="var(--ink-3)" strokeWidth="1.2" opacity="0.5" />
    </svg>
  );
}

export const ChatIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
export const TodayIcon = (p: P) => (
  <svg {...base(p.className)}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
export const CategoryIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
    <path d="M22 12A10 10 0 0 0 12 2v10z" />
  </svg>
);
export const ProgressIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M22 7l-8.5 8.5-5-5L2 17" />
    <path d="M16 7h6v6" />
  </svg>
);
export const AgentsIcon = (p: P) => (
  <svg {...base(p.className)}>
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M12 8V4M8 4h8M2 14h2M20 14h2M9 13v2M15 13v2" />
  </svg>
);
export const TaskIcon = (p: P) => (
  <svg {...base(p.className)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
);
export const SkillsIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M14.5 6.5a3 3 0 0 0-2-2M14.5 17.5a3 3 0 0 0 2-2M6.5 14.5a3 3 0 0 0 2 2M6.5 6.5a3 3 0 0 0 2-2M10.5 4.5v3M10.5 16.5v3M4.5 10.5h3M16.5 10.5h3" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
export const MemoryIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 5 17.5v-11A2.5 2.5 0 0 1 9.5 2z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 19 17.5v-11A2.5 2.5 0 0 0 14.5 2z" />
  </svg>
);
export const ModelIcon = (p: P) => (
  <svg {...base(p.className)}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
  </svg>
);
export const NotifyIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);
export const SunIcon = ({ className = "h-4 w-4" }: P) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.3 11.3 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.3-11.3 1.4-1.4" />
  </svg>
);
export const MoonIcon = ({ className = "h-4 w-4" }: P) => (
  <svg {...base(className)}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
  </svg>
);
export const LogoutIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M5 12h14m-7-7v14" />
  </svg>
);
export const ChevronDownIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const ArrowLeftIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="m12 19-7-7 7-7M19 12H5" />
  </svg>
);
export const SwitchPartnerIcon = (p: P) => (
  <svg {...base(p.className)}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
export const CheckSolidIcon = ({ className = "h-4 w-4" }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z"
      clipRule="evenodd"
    />
  </svg>
);
export const InfoIcon = ({ className = "h-4 w-4" }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-.75-4.75a.75.75 0 0 0 1.5 0v-5a.75.75 0 0 0-1.5 0v5ZM10 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
      clipRule="evenodd"
    />
  </svg>
);
