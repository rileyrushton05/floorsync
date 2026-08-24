export interface UtilizationPoint {
  label: string;
  active: number;
  capacity: number;
}

export function UtilizationAreaChart({
  points,
  width = 640,
  height = 220,
  markerIndex,
  bottleneckRange,
}: {
  points: UtilizationPoint[];
  width?: number;
  height?: number;
  markerIndex?: number;
  bottleneckRange?: [number, number];
}) {
  const padding = { top: 16, right: 34, bottom: 26, left: 32 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const maxVal = Math.max(...points.map((p) => Math.max(p.active, p.capacity))) * 1.15;

  const xAt = (i: number) => padding.left + (i / (points.length - 1)) * innerW;
  const yAt = (v: number) => padding.top + innerH - (v / maxVal) * innerH;

  const activePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(p.active)}`).join(" ");
  const activeArea = `${activePath} L ${xAt(points.length - 1)} ${padding.top + innerH} L ${xAt(0)} ${padding.top + innerH} Z`;
  const capacityPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(p.capacity)}`).join(" ");

  const gridLines = 4;

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: "block" }}>
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const y = padding.top + (innerH / gridLines) * i;
        const val = Math.round(maxVal - (maxVal / gridLines) * i);
        return (
          <g key={i}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#eef1f6" strokeWidth={1} />
            <text x={padding.left - 8} y={y + 3} fontSize={10} fill="#94a3b8" textAnchor="end">
              {val}
            </text>
          </g>
        );
      })}

      {bottleneckRange && (
        <rect
          x={xAt(bottleneckRange[0])}
          y={padding.top}
          width={xAt(bottleneckRange[1]) - xAt(bottleneckRange[0])}
          height={innerH}
          fill="#fee2e2"
          opacity={0.6}
        />
      )}

      <path d={activeArea} fill="#2563eb" opacity={0.12} />
      <path d={activePath} fill="none" stroke="#2563eb" strokeWidth={2} />
      <path d={capacityPath} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 3" />

      {points.map((p, i) => (
        <text
          key={p.label}
          x={xAt(i)}
          y={height - 6}
          fontSize={10}
          fill="#94a3b8"
          textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
        >
          {p.label}
        </text>
      ))}

      {markerIndex !== undefined && (
        <g>
          <line
            x1={xAt(markerIndex)}
            x2={xAt(markerIndex)}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#dc2626"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <circle cx={xAt(markerIndex)} cy={yAt(points[markerIndex].active)} r={4} fill="#dc2626" />
        </g>
      )}
    </svg>
  );
}
