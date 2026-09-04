type IconProps = { size?: number; color?: string };

export function IconClock({ size = 18, color = "#16a34a" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth="1.8" />
      <path d="M12 7.5V12l3 2" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCoffee({ size = 18, color = "#7c3aed" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17" stroke={color} strokeWidth="1.8" />
      <path d="M8 4.5c0 1-1 1-1 2M12 4.5c0 1-1 1-1 2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconCheck({ size = 16, color = "#fff" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill={color} fillOpacity="0.001" />
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPlay({ size = 14, color = "#0f172a" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 4.5v15l13-7.5-13-7.5Z" fill={color} />
    </svg>
  );
}

export function IconWarning({ size = 16, color = "#dc2626" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 4 2.5 20h19L12 4Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.2" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconInfo({ size = 16, color = "#2563eb" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" />
      <path d="M12 11v5.5M12 8v.1" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}


export function IconCheckCircle({ size = 18, color = "#16a34a" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" fill={color} fillOpacity="0.12" />
      <path d="M8 12.3l2.6 2.6L16.2 9" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconUser({ size = 18, color = "#334155" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.4" stroke={color} strokeWidth="1.8" />
      <path d="M5 19.5a7 7 0 0 1 14 0" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
