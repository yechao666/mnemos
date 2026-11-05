import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { GraphNode } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingBlock,
  PageHead,
  SearchInput,
  SectionHead,
  Segmented,
  Skeleton,
  Stat,
  Switch,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { fmtInt } from '@lib/format.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { buildTypeColorMap, GraphCanvas } from '../../components/project/GraphCanvas.tsx';

type NodeLimit = '60' | '120' | '200';

const LIMIT_OPTIONS: { value: NodeLimit; label: string }[] = [
  { value: '60', label: '60' },
  { value: '120', label: '120' },
  { value: '200', label: '200' },
];

/** 知识图谱：实体关系可视化、类型过滤与实体聚焦。 */
export function GraphPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { project } = useProjectContext();

  const [limit, setLimit] = useState<NodeLimit>('120');
  const [showLabels, setShowLabels] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [activeTypes, setActiveTypes] = useState<Set<string> | null>(null);
  const entityFromUrl = searchParams.get('entity') ?? '';
  const [entityQuery, setEntityQuery] = useState(entityFromUrl);

  useEffect(() => {
    setEntityQuery(entityFromUrl);
  }, [entityFromUrl]);

  const graphEnabled = project?.settings.graphEnabled ?? true;
  const { data, loading, error, refresh } = useAsync(
    () => api.graph(projectId, Number(limit)),
    [projectId, limit],
    Boolean(projectId) && graphEnabled,
  );

  // stats.topTypes 只给出前若干类型；以节点实际类型为准，避免过滤时遗漏实体。
  const typeEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data?.nodes ?? []) {
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    const order = new Map(
      (data?.stats.topTypes ?? []).map((entry, index) => [entry.type, index]),
    );
    return Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => {
      const orderA = order.get(a.type);
      const orderB = order.get(b.type);
      if (orderA != null && orderB != null) return orderA - orderB;
      if (orderA != null) return -1;
      if (orderB != null) return 1;
      return b.count - a.count;
    });
  }, [data]);
  const allTypes = useMemo(() => typeEntries.map((entry) => entry.type), [typeEntries]);
  const typesKey = allTypes.join('|');

  useEffect(() => {
    setActiveTypes(null);
  }, [typesKey]);

  const effectiveTypes = useMemo(
    () => activeTypes ?? new Set<string>(allTypes),
    [activeTypes, allTypes],
  );

  const typeColors = useMemo(
    () => buildTypeColorMap((data?.nodes ?? []).map((node) => node.type)),
    [data],
  );

  const nodes = useMemo(() => {
    const query = entityQuery.trim().toLowerCase();
    return (data?.nodes ?? []).filter((node) => {
      if (!effectiveTypes.has(node.type)) return false;
      if (query && !node.label.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, effectiveTypes, entityQuery]);

  const edges = useMemo(() => {
    const ids = new Set(nodes.map((node) => node.id));
    return (data?.edges ?? []).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }, [data, nodes]);

  const selectedNode = useMemo(
    () => (data?.nodes ?? []).find((node) => node.id === selectedId) ?? null,
    [data, selectedId],
  );

  const relations = useMemo(() => {
    if (!selectedNode || !data) return [];
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    return data.edges
      .filter(
        (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
      )
      .map((edge) => {
        const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
        return { edge, other: byId.get(otherId) ?? null };
      });
  }, [data, selectedNode]);

  const toggleType = (type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev ?? allTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const focusEntity = (node: GraphNode) => {
    setSelectedId(node.id);
    if (!effectiveTypes.has(node.type)) {
      setActiveTypes((prev) => new Set(prev ?? allTypes).add(node.type));
    }
    const query = entityQuery.trim().toLowerCase();
    if (query && !node.label.toLowerCase().includes(query)) setEntityQuery('');
  };

  const resetView = () => {
    setResetToken((token) => token + 1);
    setSelectedId(null);
  };

  const clearFilters = () => {
    setEntityQuery('');
    setActiveTypes(null);
    setSelectedId(null);
    setResetToken((token) => token + 1);
  };

  const showAllTypes = () => setActiveTypes(null);

  const header = (
    <PageHead
      eyebrow="图谱"
      title="知识图谱"
      desc="实体与关系的可视化视图，支持类型过滤与实体聚焦；图谱随记忆写入自动构建。"
      actions={
        <Button variant="ghost" icon="refresh" onClick={() => void refresh()} disabled={!graphEnabled}>
          刷新
        </Button>
      }
    />
  );

  if (!graphEnabled) {
    return (
      <div className="page">
        {header}
        <Card pad>
          <EmptyState
            icon="graph"
            title="图谱尚未启用"
            description="在项目设置中开启知识图谱后，系统会自动从记忆中抽取实体与关系并构建图谱。"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => navigate(`/projects/${projectId}/settings`)}
              >
                前往项目设置
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        {header}
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  const stats = data?.stats;

  return (
    <div className="page">
      {header}

      {error && data ? (
        <Callout tone="amber" icon="alert">
          刷新失败：{error}
        </Callout>
      ) : null}

      {loading && !data ? (
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((index) => (
            <Card key={index} pad>
              <Skeleton w={68} h={10} />
              <div className="mt-12">
                <Skeleton w={104} h={24} />
              </div>
            </Card>
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-4">
          <Stat
            label="图谱节点"
            value={fmtInt(stats.nodes)}
            icon="graph"
            tone="violet"
            hint={`当前展示 ${fmtInt(nodes.length)} 个`}
          />
          <Stat
            label="关系边"
            value={fmtInt(stats.edges)}
            icon="link"
            tone="cyan"
            hint={`当前展示 ${fmtInt(edges.length)} 条`}
          />
          <Stat
            label="图密度"
            value={stats.density.toFixed(3)}
            icon="gauge"
            tone="pink"
            hint="边数 / 可能连边数"
          />
          <Stat
            label="实体类型"
            value={fmtInt(typeEntries.length)}
            icon="layers"
            tone="amber"
            hint={allTypes.slice(0, 3).join(' · ') || '暂无类型'}
          />
        </div>
      ) : null}

      <Card pad>
        <div className="toolbar">
          <div className="toolbar-left">
            <span className="tiny dim nowrap">节点上限</span>
            <Segmented options={LIMIT_OPTIONS} value={limit} onChange={setLimit} />
            <SearchInput
              value={entityQuery}
              onChange={setEntityQuery}
              placeholder="搜索实体名称"
            />
          </div>
          <div className="toolbar-right">
            <Switch checked={showLabels} onChange={setShowLabels} label="显示标签" />
            <Button size="sm" variant="ghost" icon="refresh" onClick={resetView}>
              重置视图
            </Button>
          </div>
        </div>

        <div className="chip-row mt-12">
          <span className="tiny dim nowrap">实体类型</span>
          {typeEntries.map((entry) => {
            const active = effectiveTypes.has(entry.type);
            const color = typeColors[entry.type] ?? 'var(--chart-1)';
            return (
              <button
                key={entry.type}
                type="button"
                className={`chip chip-clickable${active ? '' : ' dim'}`}
                style={active ? { borderColor: color, color: 'var(--text-soft)' } : undefined}
                onClick={() => toggleType(entry.type)}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    background: color,
                    display: 'inline-block',
                  }}
                />
                {entry.type}
                <span className="tiny dim mono">{fmtInt(entry.count)}</span>
              </button>
            );
          })}
          {activeTypes !== null && effectiveTypes.size < allTypes.length ? (
            <Button size="sm" variant="ghost" icon="check" onClick={showAllTypes}>
              全选类型
            </Button>
          ) : null}
          {effectiveTypes.size < allTypes.length && allTypes.length > 0 ? (
            <Badge tone="slate" size="sm">
              已过滤 {allTypes.length - effectiveTypes.size} 个类型
            </Badge>
          ) : null}
        </div>
      </Card>

      <div className="split">
        <Card className="graph-canvas" style={{ padding: 0 }}>
          {loading && !data ? (
            <div style={{ padding: '90px 20px' }}>
              <LoadingBlock label="正在计算图谱布局…" />
            </div>
          ) : null}

          {!loading && data && data.nodes.length === 0 ? (
            <div style={{ padding: 24 }}>
              <EmptyState
                icon="graph"
                title="暂无图谱数据"
                description="写入记忆并启用图谱后，系统会自动抽取实体与关系并构建图谱。"
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => navigate(`/projects/${projectId}/memories`)}
                  >
                    前往记忆
                  </Button>
                }
              />
            </div>
          ) : null}

          {!loading && data && data.nodes.length > 0 && nodes.length === 0 ? (
            <div style={{ padding: 24 }}>
              <EmptyState
                icon="filter"
                title="没有匹配的实体"
                description="当前类型过滤或搜索条件没有命中任何实体，重置筛选后重试。"
                action={
                  <Button size="sm" variant="secondary" icon="refresh" onClick={clearFilters}>
                    重置筛选
                  </Button>
                }
              />
            </div>
          ) : null}

          {nodes.length > 0 ? (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              showLabels={showLabels}
              selectedId={selectedId}
              resetToken={resetToken}
              onSelect={focusEntity}
            />
          ) : null}

          {nodes.length > 0 ? (
            <div
              className="tiny dim"
              style={{ position: 'absolute', left: 14, bottom: 10, pointerEvents: 'none' }}
            >
              拖拽节点调整布局 · 悬停高亮相邻实体 · 点击查看详情
            </div>
          ) : null}
        </Card>

        <div className="detail-panel">
          {loading && !data ? (
            <Card pad>
              <LoadingBlock label="正在加载图谱数据…" />
            </Card>
          ) : selectedNode ? (
            <Card pad>
              <SectionHead
                title="实体详情"
                actions={
                  <IconButton
                    icon="x"
                    label="关闭实体详情"
                    size="sm"
                    onClick={() => setSelectedId(null)}
                  />
                }
              />
              <div className="vstack gap-12 mt-12">
                <div>
                  <div className="strong" style={{ fontSize: 16 }}>
                    {selectedNode.label}
                  </div>
                  <div className="chip-row mt-6">
                    <span className="chip">
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: typeColors[selectedNode.type] ?? 'var(--chart-1)',
                          display: 'inline-block',
                        }}
                      />
                      {selectedNode.type}
                    </span>
                  </div>
                </div>

                <div className="metric-grid">
                  <div className="metric">
                    <span className="metric-label">提及权重</span>
                    <span className="metric-value">{fmtInt(selectedNode.weight)}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">关联记忆</span>
                    <span className="metric-value">{fmtInt(selectedNode.memories)}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">关联边</span>
                    <span className="metric-value">{fmtInt(relations.length)}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">实体 ID</span>
                    <span className="metric-value mono truncate" title={selectedNode.id}>
                      {selectedNode.id}
                    </span>
                  </div>
                </div>

                <div className="divider" />
                <div className="section-title">关联关系</div>
                {relations.length ? (
                  <div className="vstack gap-6">
                    {relations.map(({ edge, other }) => (
                      <button
                        key={edge.id}
                        type="button"
                        className="chip-clickable"
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--surface)',
                          border: '1px solid var(--border-faint)',
                        }}
                        onClick={() => {
                          if (other) focusEntity(other);
                        }}
                        disabled={!other}
                      >
                        <div className="between gap-8">
                          <span className="hstack gap-6" style={{ minWidth: 0 }}>
                            <span className="tiny dim nowrap">{edge.relation}</span>
                            <span className="small truncate" style={{ maxWidth: 128 }}>
                              {other?.label ?? '未知实体'}
                            </span>
                          </span>
                          <span className="tiny dim mono nowrap">
                            {edge.weight.toFixed(2)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="tiny dim">该实体暂无关联边。</div>
                )}
              </div>
            </Card>
          ) : (
            <Card pad>
              <SectionHead title="图谱说明" desc="实体关系由记忆自动抽取" />
              <div className="mt-12">
                <Callout tone="violet" icon="info">
                  悬停节点高亮相邻实体，点击节点查看详情，拖拽可调整布局。图谱随写入增量重建。
                </Callout>
              </div>
              <div className="divider" style={{ margin: '14px 0' }} />
              <div className="section-title">类型图例</div>
              <div className="chip-row mt-8">
                {allTypes.length ? (
                  allTypes.map((type) => (
                    <span key={type} className="chip">
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: typeColors[type] ?? 'var(--chart-1)',
                          display: 'inline-block',
                        }}
                      />
                      {type}
                    </span>
                  ))
                ) : (
                  <span className="tiny dim">暂无实体类型。</span>
                )}
              </div>
              <div className="divider" style={{ margin: '14px 0' }} />
              <div className="vstack gap-6">
                <div className="tiny dim">节点半径映射实体权重，连线透明度映射关系强度。</div>
                <div className="tiny dim">
                  当前展示上限 {limit} 个节点；提高上限会重新计算布局，可能影响性能。
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
