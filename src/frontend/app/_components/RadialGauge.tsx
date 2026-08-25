export function RadialGauge({
  percent,
  size = 96,
  thickness = 10,
  color = "#2563eb",
  label,
}: {
  percent: number;
  size?: number;
  thickness?: number;
  color?: string;
  label?: string;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = (clamped / 100) * circumference;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef1f6" strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
        />
      </g>
      <text x={size / 2} y={size / 2 - 2} textAnchor="middle" fontSize={size * 0.22} fontWeight={800} fill="#0f172a">
        {clamped}%
      </text>
      {label && (
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" fontSize={size * 0.1} fill="#64748b">
          {label}
        </text>
      )}
    </svg>
  );
}
