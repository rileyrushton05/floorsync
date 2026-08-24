type IconProps = { size?: number; color?: string };

export function IconBars({ size = 18, color = "#2563eb" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="12" width="3.5" height="8" rx="1" fill={color} />
      <rect x="10.2" y="7" width="3.5" height="13" rx="1" fill={color} />
      <rect x="16.4" y="3" width="3.5" height="17" rx="1" fill={color} />
    </svg>
  );
}

export function IconGauge({ size = 18, color = "#16a34a" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 16a8 8 0 1 1 16 0" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M12 16l4-5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconTruck({ size = 18, color = "#7c3aed" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="7" width="11" height="9" rx="1.5" stroke={color} strokeWidth="2" />
      <path d="M14 10h4l3 3v3h-7z" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="8" cy="18" r="1.6" fill={color} />
      <circle cx="17.5" cy="18" r="1.6" fill={color} />
    </svg>
  );
}

export function IconUsers({ size = 18, color = "#0891b2" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="8" r="3" stroke={color} strokeWidth="2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.4" stroke={color} strokeWidth="2" />
      <path d="M15.5 19a4.2 4.2 0 0 1 6 0" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconClipboard({ size = 18, color = "#d97706" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="5" y="4" width="14" height="17" rx="2" stroke={color} strokeWidth="2" />
      <rect x="9" y="2.5" width="6" height="3" rx="1" fill={color} />
      <path d="M8 12h8M8 16h5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconBell({ size = 18, color = "#334155" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconWarning({ size = 16, color = "#b91c1c" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 4 2.5 20h19L12 4Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.2" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconBulb({ size = 18, color = "#2563eb" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M9 18h6M10 21h4" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 3a6.5 6.5 0 0 0-3.5 12c.6.4 1 1.1 1 1.9V17h5v-.1c0-.8.4-1.5 1-1.9A6.5 6.5 0 0 0 12 3Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
