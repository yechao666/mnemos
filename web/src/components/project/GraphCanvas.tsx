import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '@shared';
import { CHART_PALETTE } from '@charts';

/**
 * 自实现的知识图谱画布：确定性力导向布局（约 120 次迭代），
 * 不依赖任何可视化库；仅在数据变化时计算布局，避免逐帧 setState。
 */

const CANVAS_W = 980;
const CANVAS_H = 640;
const PAD = 56;
const ITERATIONS = 120;

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  showLabels: boolean;
  selectedId: string | null;
  resetToken: number;
  onSelect: (node: GraphNode) => void;
}

interface Point {
  x: number;
  y: number;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 实体类型 → 图表色板（按类型名排序，保证跨页面颜色一致）。 */
export function buildTypeColorMap(types: string[]): Record<string, string> {
  const unique = Array.from(new Set(types)).sort();
  const map: Record<string, string> = {};
  unique.forEach((type, index) => {
    map[type] = CHART_PALETTE[index % CHART_PALETTE.length];
  });
  return map;
}

function buildLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Point> {
  const count = nodes.length;
  const layout = new Map<string, Point>();
  if (!count) return layout;

  const center = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const points: Point[] = nodes.map((node, index) => {
    // 黄金角螺旋初始化：确定性、分布均匀，且不依赖 Math.random。
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt((index + 0.5) / count) * Math.min(CANVAS_W, CANVAS_H) * 0.42;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });

  const k = Math.sqrt((CANVAS_W * CANVAS_H) / count) * 0.85;
  const springs = edges
    .map((edge) => {
      const a = indexOf.get(edge.source);
      const b = indexOf.get(edge.target);
      if (a == null || b == null || a === b) return null;
      const weight = Number.isFinite(edge.weight) ? Math.min(3, Math.max(0.2, edge.weight)) : 1;
      return { a, b, weight };
    })
    .filter((spring): spring is { a: number; b: number; weight: number } => spring !== null);

  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const alpha = 1 - iter / ITERATIONS;
    const disp: Point[] = points.map(() => ({ x: 0, y: 0 }));

    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const a = points[i];
        const b = points[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = ((hashString(nodes[i].id) % 13) - 6) * 0.12;
          dy = ((hashString(nodes[j].id) % 13) - 6) * 0.12;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const force = Math.min((k * k) / distance, 60) * 0.05 * alpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    for (const spring of springs) {
      const a = points[spring.a];
      const b = points[spring.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = ((distance * distance) / k) * 0.008 * alpha * spring.weight;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      disp[spring.a].x += fx;
      disp[spring.a].y += fy;
      disp[spring.b].x -= fx;
      disp[spring.b].y -= fy;
    }

    for (let i = 0; i < count; i += 1) {
      const point = points[i];
      const delta = disp[i];
      delta.x += (center.x - point.x) * 0.012 * alpha;
      delta.y += (center.y - point.y) * 0.012 * alpha;
      const length = Math.hypot(delta.x, delta.y);
      const maxStep = 7;
      if (length > maxStep) {
        delta.x = (delta.x / length) * maxStep;
        delta.y = (delta.y / length) * maxStep;
      }
      point.x = Math.max(PAD, Math.min(CANVAS_W - PAD, point.x + delta.x));
      point.y = Math.max(PAD, Math.min(CANVAS_H - PAD, point.y + delta.y));
    }
  }

  // 最终做一次确定性的最小间距消解，避免高权重节点/同簇节点重叠。
  const maxWeight = nodes.reduce((max, node) => Math.max(max, node.weight), 0);
  const radii = nodes.map((node) =>
    6 + Math.sqrt(maxWeight > 0 ? Math.max(0, node.weight) / maxWeight : 0) * 11,
  );
  for (let pass = 0; pass < 24; pass += 1) {
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const a = points[i];
        const b = points[j];
        const minDistance = radii[i] + radii[j] + 6;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minDistance) continue;
        if (distance < 0.01) {
          dx = ((hashString(nodes[i].id) % 17) - 8) * 0.2;
          dy = ((hashString(nodes[j].id) % 17) - 8) * 0.2;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const push = (minDistance - distance) / 2;
        const ux = (dx / distance) * push;
        const uy = (dy / distance) * push;
        a.x = Math.max(PAD, Math.min(CANVAS_W - PAD, a.x + ux));
        a.y = Math.max(PAD, Math.min(CANVAS_H - PAD, a.y + uy));
        b.x = Math.max(PAD, Math.min(CANVAS_W - PAD, b.x - ux));
        b.y = Math.max(PAD, Math.min(CANVAS_H - PAD, b.y - uy));
      }
    }
  }

  nodes.forEach((node, index) => layout.set(node.id, points[index]));
  return layout;
}

function truncateLabel(label: string): string {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

export function GraphCanvas({
  nodes,
  edges,
  showLabels,
  selectedId,
  resetToken,
  onSelect,
}: GraphCanvasProps) {
  const uid = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Point>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  const layout = useMemo(() => buildLayout(nodes, edges), [nodes, edges]);
  const colors = useMemo(() => buildTypeColorMap(nodes.map((node) => node.type)), [nodes]);
  const gradients = useMemo(() => {
    const map: Record<string, string> = {};
    Object.keys(colors).forEach((type, index) => {
      map[type] = `glow-${uid}-${index}`;
    });
    return map;
  }, [colors, uid]);

  const view = useMemo(() => {
    if (!layout.size) return { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of layout.values()) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return {
      x: minX - PAD,
      y: minY - PAD,
      width: Math.max(420, maxX - minX + PAD * 2),
      height: Math.max(320, maxY - minY + PAD * 2),
    };
  }, [layout]);

  const maxWeight = useMemo(() => nodes.reduce((max, node) => Math.max(max, node.weight), 0), [nodes]);
  const maxEdgeWeight = useMemo(
    () => edges.reduce((max, edge) => Math.max(max, edge.weight), 0),
    [edges],
  );

  const labelIds = useMemo(() => {
    if (!showLabels) return new Set<string>();
    return new Set(
      [...nodes]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 32)
        .map((node) => node.id),
    );
  }, [nodes, showLabels]);

  const activeId = hoveredId ?? selectedId;
  const activeSet = useMemo(() => {
    if (!activeId) return null;
    const set = new Set<string>([activeId]);
    for (const edge of edges) {
      if (edge.source === activeId) set.add(edge.target);
      else if (edge.target === activeId) set.add(edge.source);
    }
    return set;
  }, [activeId, edges]);

  useEffect(() => {
    setOverrides({});
    setHoveredId(null);
  }, [nodes]);

  useEffect(() => {
    setOverrides({});
    setHoveredId(null);
    setDragging(null);
  }, [resetToken]);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const pointer = svg.createSVGPoint();
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const local = pointer.matrixTransform(matrix.inverse());
      const x = Math.max(view.x + 8, Math.min(view.x + view.width - 8, local.x));
      const y = Math.max(view.y + 8, Math.min(view.y + view.height - 8, local.y));
      setOverrides((prev) => ({ ...prev, [dragging]: { x, y } }));
    };
    const stop = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging, view]);

  const positionOf = (id: string): Point =>
    overrides[id] ?? layout.get(id) ?? { x: CANVAS_W / 2, y: CANVAS_H / 2 };

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      width="100%"
      height={520}
      role="img"
      aria-label="知识图谱：实体与关系网络"
      style={{ display: 'block', touchAction: 'none' }}
    >
      <defs>
        {Object.entries(colors).map(([type, color], index) => (
          <radialGradient key={type} id={`glow-${uid}-${index}`}>
            <stop offset="0%" stopColor={color} stopOpacity="0.42" />
            <stop offset="65%" stopColor={color} stopOpacity="0.12" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>

      <g>
        {edges.map((edge) => {
          const source = positionOf(edge.source);
          const target = positionOf(edge.target);
          const normalized = maxEdgeWeight > 0 ? edge.weight / maxEdgeWeight : 0;
          const highlighted =
            activeId !== null && (edge.source === activeId || edge.target === activeId);
          const dimmed = activeSet !== null && !highlighted;
          return (
            <line
              key={edge.id}
              className="graph-edge"
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={highlighted ? 'var(--cyan)' : 'var(--chart-1)'}
              strokeWidth={highlighted ? 1.7 : 0.6 + normalized * 1.5}
              strokeOpacity={dimmed ? 0.035 : highlighted ? 0.75 : 0.08 + normalized * 0.32}
              style={{ pointerEvents: 'none' }}
            />
          );
        })}
      </g>

      <g>
        {nodes.map((node) => {
          const point = positionOf(node.id);
          const color = colors[node.type] ?? 'var(--chart-1)';
          const weightRatio = maxWeight > 0 ? Math.max(0, node.weight) / maxWeight : 0;
          // 时间表达式作为背景锚点：更小、更淡，且默认不参与标签，避免遮挡真实实体
          const isTemporal = node.type === 'time';
          const radius = (6 + Math.sqrt(weightRatio) * 11) * (isTemporal ? 0.62 : 1);
          const dimmed = activeSet !== null && !activeSet.has(node.id);
          const active = activeId === node.id;
          const showLabel = active || (!isTemporal && labelIds.has(node.id));
          return (
            <g
              key={node.id}
              className="graph-node"
              style={{
                opacity: dimmed ? 0.18 : 1,
                transition: 'opacity 180ms var(--ease)',
              }}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() =>
                setHoveredId((prev) => (prev === node.id ? null : prev))
              }
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragging(node.id);
                onSelect(node);
              }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={radius * (active ? 3.1 : 2.6)}
                fill={`url(#${gradients[node.type] ?? ''})`}
                style={{ pointerEvents: 'none' }}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={active ? radius + 1.2 : radius}
                fill={color}
                fillOpacity={isTemporal ? 0.45 : 0.88}
                stroke={active ? 'var(--text)' : 'rgba(255, 255, 255, 0.24)'}
                strokeWidth={active ? 1.6 : 1}
              />
              {showLabel ? (
                <text
                  x={point.x}
                  y={point.y + radius + 13}
                  textAnchor="middle"
                  fontSize={11}
                  fill={active ? 'var(--text)' : 'var(--text-muted)'}
                  stroke="var(--bg)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {truncateLabel(node.label)}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
