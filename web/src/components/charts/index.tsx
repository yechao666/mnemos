import { useId, useMemo } from 'react';

/**
 * 手绘 SVG 图表：零依赖、跟随主题变量、支持渐变与悬停提示。
 * 所有图表都用 viewBox 实现自适应宽度。
 */

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const scaled = max / pow;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * pow;
}

function pathFrom(points: { x: number; y: number }[], smooth = true): string {
  if (!points.length) return '';
  if (!smooth || points.length < 3) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  }
  let d = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const cx = (p0.x + p1.x) / 2;
    d += ` C${cx.toFixed(2)},${p0.y.toFixed(2)} ${cx.toFixed(2)},${p1.y.toFixed(2)} ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* 迷你走势图                                                          */
/* ------------------------------------------------------------------ */

export function Sparkline({
  data,
  color = 'var(--violet)',
  width = 100,
  height = 28,
  fill = true,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  const id = useId().replace(/[:]/g, '');
  const pts = useMemo(() => {
    if (data.length < 2) return [];
    const max = Math.max(...data);
    const min = Math.min(...data);
    const span = max - min || 1;
    const stepX = width / (data.length - 1);
    return data.map((v, i) => ({ x: i * stepX, y: height - 3 - ((v - min) / span) * (height - 8) }));
  }, [data, width, height]);

  if (pts.length < 2) return <span style={{ display: 'inline-block', width, height }} />;
  const line = pathFrom(pts, true);
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="spark" aria-hidden="true">
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#sp-${id})`} /> : null}
      <path d={line} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 折线 / 面积图                                                       */
/* ------------------------------------------------------------------ */

export interface ChartSeries {
  name: string;
  color: string;
}

export interface ChartPoint {
  label: string;
  values: number[];
}

export function LineChart({
  points,
  series,
  height = 216,
  showGrid = true,
  valueFormat = (n: number) => n.toLocaleString('zh-CN'),
}: {
  points: ChartPoint[];
  series: ChartSeries[];
  height?: number;
  showGrid?: boolean;
  valueFormat?: (n: number) => string;
}) {
  const id = useId().replace(/[:]/g, '');
  const width = 760;
  const pad = { top: 12, right: 8, bottom: 26, left: 38 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const max = useMemo(() => {
    let m = 0;
    for (const p of points) for (const v of p.values) m = Math.max(m, v);
    return niceMax(m);
  }, [points]);

  const xAt = (i: number) => pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yAt = (v: number) => pad.top + innerH - (v / max) * innerH;

  const gridLines = useMemo(() => [0, 0.25, 0.5, 0.75, 1].map((r) => ({ y: pad.top + innerH - r * innerH, value: max * r })), [max, innerH, pad.top]);

  const labelIdx = useMemo(() => {
    if (points.length <= 7) return points.map((_, i) => i);
    const step = Math.ceil(points.length / 6);
    return points.map((_, i) => i).filter((i) => i % step === 0 || i === points.length - 1);
  }, [points]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="趋势图"
      style={{ overflow: 'visible' }}
    >
      <defs>
        {series.map((s, si) => (
          <linearGradient key={s.name} id={`lg-${id}-${si}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={si === 0 ? 0.3 : 0.16} />
            <stop offset="100%" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>

      {showGrid
        ? gridLines.map((g, i) => (
            <g key={i}>
              <line x1={pad.left} x2={width - pad.right} y1={g.y} y2={g.y} stroke="var(--chart-grid)" strokeDasharray="3 5" />
              <text x={pad.left - 8} y={g.y + 3.5} textAnchor="end" fontSize="9.5" fill="var(--text-dim)" fontFamily="var(--font-mono)">
                {valueFormat(Math.round(g.value))}
              </text>
            </g>
          ))
        : null}

      {series.map((s, si) => {
        const pts = points.map((p, i) => ({ x: xAt(i), y: yAt(p.values[si] ?? 0) }));
        const line = pathFrom(pts, true);
        const area = `${line} L${xAt(points.length - 1)},${pad.top + innerH} L${xAt(0)},${pad.top + innerH} Z`;
        return (
          <g key={s.name}>
            {si === 0 ? <path d={area} fill={`url(#lg-${id}-${si})`} /> : null}
            <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            {pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="2.6" fill="var(--bg)" stroke={s.color} strokeWidth="1.6">
                <title>{`${points[i]?.label} · ${s.name} ${valueFormat(points[i]?.values[si] ?? 0)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      {labelIdx.map((i) => (
        <text
          key={i}
          x={xAt(i)}
          y={height - 8}
          textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
          fontSize="9.5"
          fill="var(--text-dim)"
        >
          {points[i]?.label}
        </text>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 柱状图                                                              */
/* ------------------------------------------------------------------ */

export function BarChart({
  data,
  height = 180,
  valueFormat = (n: number) => n.toLocaleString('zh-CN'),
  color = 'var(--chart-1)',
  horizontal = false,
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
  valueFormat?: (n: number) => string;
  color?: string;
  horizontal?: boolean;
}) {
  const max = useMemo(() => niceMax(Math.max(...data.map((d) => d.value), 1)), [data]);

  if (horizontal) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.map((d) => (
          <div key={d.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(72px, 132px) 1fr 56px', gap: 10, alignItems: 'center' }}>
            <span className="small muted truncate">{d.label}</span>
            <span className="progress" style={{ height: 7 }}>
              <span
                className="progress-bar"
                style={{
                  display: 'block',
                  width: `${Math.max(2, (d.value / max) * 100)}%`,
                  background: d.color ?? color,
                }}
              />
            </span>
            <span className="mono tiny dim right">{valueFormat(d.value)}</span>
          </div>
        ))}
      </div>
    );
  }

  const width = 760;
  const pad = { top: 10, right: 6, bottom: 24, left: 6 };
  const innerH = height - pad.top - pad.bottom;
  const slot = (width - pad.left - pad.right) / Math.max(1, data.length);
  const barW = Math.min(38, slot * 0.56);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="柱状图">
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="var(--border)" />
      {data.map((d, i) => {
        const h = Math.max(2, (d.value / max) * innerH);
        const x = pad.left + slot * i + (slot - barW) / 2;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={pad.top + innerH - h}
              width={barW}
              height={h}
              rx="5"
              fill={d.color ?? color}
              opacity="0.82"
            >
              <title>{`${d.label} · ${valueFormat(d.value)}`}</title>
            </rect>
            <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize="9.5" fill="var(--text-dim)">
              {d.label.length > 6 ? `${d.label.slice(0, 5)}…` : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 环形图                                                              */
/* ------------------------------------------------------------------ */

export function DonutChart({
  data,
  size = 168,
  thickness = 15,
  centerValue,
  centerLabel,
  valueFormat = (n: number) => n.toLocaleString('zh-CN'),
}: {
  data: { label: string; value: number; color?: string }[];
  size?: number;
  thickness?: number;
  centerValue?: string | number;
  centerLabel?: string;
  valueFormat?: (n: number) => string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth={thickness} />
          {data.map((d, i) => {
            const len = (d.value / total) * c;
            const dash = `${Math.max(0, len - 2)} ${c}`;
            const el = (
              <circle
                key={d.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={d.color ?? PALETTE[i % PALETTE.length]}
                strokeWidth={thickness}
                strokeLinecap="round"
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${d.label} · ${valueFormat(d.value)} (${((d.value / total) * 100).toFixed(1)}%)`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: 21, fontWeight: 650, letterSpacing: '-0.03em' }}>{centerValue ?? valueFormat(total)}</div>
          {centerLabel ? <div className="tiny dim" style={{ marginTop: 2 }}>{centerLabel}</div> : null}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 120 }}>
        {data.map((d, i) => (
          <div key={d.label} className="hstack gap-8">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 3,
                background: d.color ?? PALETTE[i % PALETTE.length],
                flexShrink: 0,
              }}
            />
            <span className="small muted truncate" style={{ flex: 1 }}>{d.label}</span>
            <span className="mono tiny" style={{ color: 'var(--text-soft)' }}>{((d.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { PALETTE as CHART_PALETTE };
