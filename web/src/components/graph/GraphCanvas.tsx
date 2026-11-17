import { useMemo } from 'react';
import type { EntityGraphEdge, EntityGraphNode } from '@lib/types.ts';
import { entityTypeMeta } from '@lib/constants.ts';

/**
 * 轻量 SVG 关系图（不引第三方图库）：
 *  - 布局：确定性「向日葵 / 圆形」分布（黄金角 + sqrt 半径），weight 越高越靠近中心；
 *  - 节点大小按 weight（关联记忆 salience 累计），颜色按实体类型；
 *  - 点击节点高亮相邻边与邻居，再次点击或点空白清除选中；
 *  - 节点数较多时只给高权重 / 选中 / 邻居节点画标签，避免糊成一团。
 *
 * 布局在客户端一次计算（≤500 节点），不触发布局抖动，也不依赖动画帧。
 */

const WIDTH = 900;
const HEIGHT = 560;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const GOLDEN_ANGLE = 2.399963229728653;

export interface GraphNodeLayout {
  node: EntityGraphNode;
  x: number;
  y: number;
  r: number;
}

function nodeWeight(node: EntityGraphNode): number {
  return Math.max(node.weight, node.memories, 0);
}

/** 计算节点坐标与半径；导出便于测试/复用。 */
export function layoutGraphNodes(nodes: EntityGraphNode[]): GraphNodeLayout[] {
  if (nodes.length === 0) return [];
  const sorted = [...nodes].sort(
    (left, right) => nodeWeight(right) - nodeWeight(left) || left.label.localeCompare(right.label, 'zh-CN'),
  );
  const maxWeight = Math.max(...sorted.map(nodeWeight), 1);
  const maxRadius = Math.min(WIDTH, HEIGHT) / 2 - 60;
  const radiusScale = Math.min(1, Math.sqrt(48 / sorted.length));
  const centerPull = 0.24;

  if (sorted.length === 1) {
    return [{ node: sorted[0]!, x: CENTER_X, y: CENTER_Y, r: 22 }];
  }

  return sorted.map((node, index) => {
    const weightRatio = nodeWeight(node) / maxWeight;
    const t = (index + 0.5) / sorted.length;
    const ring = Math.sqrt(t) * maxRadius * (1 - centerPull * weightRatio);
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    return {
      node,
      x: CENTER_X + Math.cos(angle) * ring,
      y: CENTER_Y + Math.sin(angle) * ring * 0.9,
      r: Math.max(4, (5 + 17 * Math.sqrt(weightRatio)) * radiusScale),
    };
  });
}

function shortLabel(label: string, max = 10): string {
  const trimmed = label.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function nodeColor(node: EntityGraphNode): string {
  return `var(--${entityTypeMeta(node.type).tone})`;
}

export interface GraphCanvasProps {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function GraphCanvas({ nodes, edges, selectedId, onSelect }: GraphCanvasProps) {
  const layout = useMemo(() => layoutGraphNodes(nodes), [nodes]);
  const layoutById = useMemo(() => new Map(layout.map((item) => [item.node.id, item])), [layout]);

  const neighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const result = new Set<string>();
    for (const edge of edges) {
      if (edge.source === selectedId) result.add(edge.target);
      if (edge.target === selectedId) result.add(edge.source);
    }
    return result;
  }, [edges, selectedId]);

  const labelIds = useMemo(() => {
    const sorted = [...layout].sort((left, right) => nodeWeight(right.node) - nodeWeight(left.node));
    const limit = nodes.length <= 36 ? nodes.length : 20;
    const result = new Set(sorted.slice(0, limit).map((item) => item.node.id));
    if (selectedId) result.add(selectedId);
    for (const id of neighborIds) result.add(id);
    return result;
  }, [layout, nodes.length, selectedId, neighborIds]);

  const visibleEdges = useMemo(
    () =>
      edges
        .map((edge) => {
          const source = layoutById.get(edge.source);
          const target = layoutById.get(edge.target);
          return source && target ? { edge, source, target } : null;
        })
        .filter((item): item is { edge: EntityGraphEdge; source: GraphNodeLayout; target: GraphNodeLayout } =>
          Boolean(item),
        ),
    [edges, layoutById],
  );

  return (
    <div className="graph-canvas">
      <svg
        className="graph-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`实体关系图：${nodes.length} 个节点、${edges.length} 条边`}
        onClick={() => onSelect(null)}
      >
        <g className="graph-edges">
          {visibleEdges.map(({ edge, source, target }) => {
            const active = Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId);
            const dim = Boolean(selectedId) && !active;
            return (
              <line
                key={edge.id}
                className={`graph-edge${active ? ' is-active' : ''}${dim ? ' is-dim' : ''}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                style={{
                  stroke: active ? 'var(--violet)' : 'var(--slate)',
                  strokeWidth: active ? 1.8 : 0.7,
                  strokeOpacity: active ? 0.75 : dim ? 0.03 : 0.14,
                }}
              >
                <title>{`${source.node.label} — ${target.node.label}（${edge.relation}）`}</title>
              </line>
            );
          })}
        </g>

        <g className="graph-nodes">
          {layout.map(({ node, x, y, r }) => {
            const selected = node.id === selectedId;
            const neighbor = neighborIds.has(node.id);
            const dim = Boolean(selectedId) && !selected && !neighbor;
            const showLabel = labelIds.has(node.id);
            return (
              <g
                key={node.id}
                className={`graph-node${selected ? ' is-selected' : ''}${neighbor ? ' is-neighbor' : ''}${dim ? ' is-dim' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}（${entityTypeMeta(node.type).label}），关联 ${node.memories} 条记忆`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(selected ? null : node.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(selected ? null : node.id);
                  }
                }}
              >
                <title>
                  {`${node.label}\n类型：${entityTypeMeta(node.type).label}\n权重：${node.weight} · 关联记忆：${node.memories}`}
                </title>
                {selected || neighbor ? (
                  <circle
                    cx={x}
                    cy={y}
                    r={r + 4}
                    fill="none"
                    style={{
                      stroke: selected ? 'var(--violet)' : 'var(--cyan)',
                      strokeOpacity: selected ? 0.9 : 0.45,
                      strokeWidth: 1.2,
                    }}
                  />
                ) : null}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  style={{
                    fill: nodeColor(node),
                    fillOpacity: dim ? 0.18 : selected ? 1 : 0.82,
                    stroke: selected ? '#ffffff' : 'rgba(0,0,0,0.35)',
                    strokeWidth: selected ? 1.6 : 0.8,
                  }}
                />
                {showLabel ? (
                  <text
                    x={x}
                    y={y + r + 11}
                    textAnchor="middle"
                    fontSize={selected ? 11 : 9.5}
                    style={{
                      fill: dim ? 'var(--text-dim)' : 'var(--text-soft)',
                      opacity: dim ? 0.4 : 1,
                      stroke: 'rgba(8, 6, 15, 0.88)',
                      strokeWidth: 3,
                      paintOrder: 'stroke',
                    }}
                  >
                    {shortLabel(node.label, selected ? 14 : 10)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      {selectedId ? (
        <div className="graph-hint tiny dim">已选中节点：相邻边高亮；点击空白处或再次点击节点取消选中。</div>
      ) : (
        <div className="graph-hint tiny dim">点击节点查看相邻关系；节点大小代表权重（关联记忆 salience）。</div>
      )}
    </div>
  );
}
