export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  segments,
  size = 120,
  thickness = 16,
  centerTop,
  centerBottom,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerTop?: string;
  centerBottom?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  const arcs = segments.reduce<{ dash: number; gap: number; offset: number }[]>((acc, s) => {
    const dash = (s.value / total) * circumference;
    const prevOffset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].dash : 0;
    acc.push({ dash, gap: circumference - dash, offset: prevOffset });
    return acc;
  }, []);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#eef1f6"
          strokeWidth={thickness}
        />
        {segments.map((s, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={`${arcs[i].dash} ${arcs[i].gap}`}
            strokeDashoffset={-arcs[i].offset}
            strokeLinecap="butt"
          />
        ))}
      </g>
      {(centerTop || centerBottom) && (
        <g textAnchor="middle">
          {centerTop && (
            <text x={size / 2} y={size / 2 - 2} fontSize={size * 0.16} fontWeight={800} fill="#0f172a">
              {centerTop}
            </text>
          )}
          {centerBottom && (
            <text x={size / 2} y={size / 2 + 16} fontSize={size * 0.09} fill="#64748b">
              {centerBottom}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
