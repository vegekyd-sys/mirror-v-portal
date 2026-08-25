// Minimal stroke icon set (feather-style). Rendered at 1.5–2px stroke,
// inherits currentColor so icons pick up the surrounding text color.
import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function S({ size = 14, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

export const IconRefresh = (p: IconProps) => (
  <S {...p}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </S>
);

export const IconPlus = (p: IconProps) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
);

export const IconSearch = (p: IconProps) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </S>
);

export const IconChevronDown = (p: IconProps) => (
  <S {...p}>
    <path d="M6 9l6 6 6-6" />
  </S>
);

export const IconArrowLeft = (p: IconProps) => (
  <S {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </S>
);

export const IconArrowRight = (p: IconProps) => (
  <S {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </S>
);

export const IconLogout = (p: IconProps) => (
  <S {...p}>
    <path d="M7 17L17 7M7 7h10v10" />
  </S>
);

export const IconTrash = (p: IconProps) => (
  <S {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </S>
);

export const IconSave = (p: IconProps) => (
  <S {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </S>
);

export const IconAlert = (p: IconProps) => (
  <S {...p}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h13.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </S>
);

export const IconCopy = (p: IconProps) => (
  <S {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
);

export const IconCheck = (p: IconProps) => (
  <S {...p}>
    <path d="M20 6L9 17l-5-5" />
  </S>
);

export const IconX = (p: IconProps) => (
  <S {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </S>
);

export const IconEdit = (p: IconProps) => (
  <S {...p}>
    <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </S>
);

export const IconBox = (p: IconProps) => (
  <S {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </S>
);

export const IconChat = (p: IconProps) => (
  <S {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </S>
);

export const IconSend = (p: IconProps) => (
  <S {...p}>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </S>
);

export const IconRocket = (p: IconProps) => (
  <S {...p}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </S>
);

/**
 * Nexus logo mark — a hub connecting nodes. "Nexus" = 连接点/枢纽：
 * 一个中心节点向外连接多个运行节点，代表平台连接并托管众多 Agent。
 * Rendered in currentColor so it picks up the surrounding text color.
 */
export const IconNexus = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    {/* 连接线：中枢 → 三个节点 */}
    <path
      d="M12 12V5.2M12 12l-6.2 5.6M12 12l6.2 5.6"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    {/* 中枢节点 */}
    <circle cx="12" cy="12" r="3.4" fill="currentColor" />
    {/* 外围运行节点 */}
    <circle cx="12" cy="4.2" r="2.1" fill="currentColor" />
    <circle cx="5.8" cy="17.8" r="2.1" fill="currentColor" />
    <circle cx="18.2" cy="17.8" r="2.1" fill="currentColor" />
  </svg>
);
