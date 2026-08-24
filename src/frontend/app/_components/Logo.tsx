import Link from "next/link";

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#2563eb" />
      <path d="M6 17V11.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M10.4 17V7.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M14.8 17V13.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M19.2 17V9.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ size = 20, href = "/" }: { size?: number; href?: string }) {
  return (
    <Link
      href={href}
      aria-label="FloorSync home"
      style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}
    >
      <Logo size={size + 6} />
      <span style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.01em", color: "#0f172a" }}>
        FloorSync
      </span>
    </Link>
  );
}
