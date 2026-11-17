import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { EntitySummary } from '@lib/types.ts';
import { entityTypeMeta } from '@lib/constants.ts';
import { api } from '@lib/api.ts';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { fmtInt, truncateMiddle } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHead,
  SectionHead,
  SearchInput,
  Select,
  Skeleton,
  Stat,
  Switch,
  Table,
} from '@ui';
import { GraphCanvas } from '../components/graph/GraphCanvas.tsx';

const LIMIT_OPTIONS = [
  { value: '60', label: '60 个节点' },
  { value: '100', label: '100 个节点' },
  { value: '200', label: '200 个节点' },
  { value: '500', label: '500 个节点（上限）' },
];

const MAX_EDGE_ROWS = 200;

/**
 * 分区「图谱」页（v6.1 P2）：
 *  - 统计卡：节点 / 边 / 类型 Top；
 *  - 实体关系图：SVG 圆形近似布局（节点按 weight、点击高亮相邻边）；
 *  - 实体列表（q / type 筛选、mentionCount）与关系边表；
 *  - 可选人筛选（人级子图）、空态 / 错误态。
 *
 * 数据来自 GET /api/partitions/:p/graph 与 /entities；实体由写入管线的 extract 任务产生。
 */
export function PartitionGraphPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();

  const [personInput, setPersonInput] = useState('');
  const [limit, setLimit] = useState('100');
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adjacentOnly, setAdjacentOnly] = useState(true);

  const personRef = useDebounced(personInput, 350).trim();
  const entityQuery = useDebounced(q, 300).trim();
  const nodeLimit = Number(limit) || 100;

  const graphQuery = useAsync(
    () => api.partitions.graph(partitionId, { personId: personRef || undefined, limit: nodeLimit }),
    [partitionId, personRef, nodeLimit],
    Boolean(partitionId),
  );
  const entitiesQuery = useAsync(
    () =>
      api.partitions.entities(partitionId, {
        personId: personRef || undefined,
        q: entityQuery || undefined,
        limit: 200,
      }),
    [partitionId, personRef, entityQuery],
    Boolean(partitionId),
  );

  const graph = graphQuery.data;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const entities = entitiesQuery.data?.items ?? [];

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const nodeLabel = (id: string) => nodeById.get(id)?.label ?? truncateMiddle(id, 8, 4);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
  }, [nodes]);

  const typeOptions = useMemo(() => {
    // 图受节点上限约束，可能缺少某些类型；类型下拉合并实体列表里出现过的类型。
    const counts = new Map<string, number>(typeCounts.map((item) => [item.type, item.count]));
    for (const entity of entities) {
      if (counts.has(entity.type)) continue;
      counts.set(entity.type, entities.filter((item) => item.type === entity.type).length);
    }
    return [
      { value: '', label: '全部类型' },
      ...[...counts.entries()].map(([type, count]) => ({
        value: type,
        label: `${entityTypeMeta(type).label}（${count}）`,
      })),
    ];
  }, [typeCounts, entities]);

  const filteredEntities = useMemo(
    () => (typeFilter ? entities.filter((entity) => entity.type === typeFilter) : entities),
    [entities, typeFilter],
  );

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const neighborCount = useMemo(() => {
    if (!selectedId) return 0;
    return edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).length;
  }, [edges, selectedId]);

  // 切换人 / 刷新后选中节点可能已不在图里，清理掉避免悬空高亮。
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [nodeById, selectedId]);

  const edgeRows = useMemo(() => {
    const list =
      adjacentOnly && selectedId
        ? edges.filter((edge) => edge.source === selectedId || edge.target === selectedId)
        : edges;
    return list.slice(0, MAX_EDGE_ROWS);
  }, [edges, selectedId, adjacentOnly]);

  const refreshAll = () => {
    void graphQuery.refresh();
    void entitiesQuery.refresh();
  };

  const selectEntity = (entity: EntitySummary) => {
    if (nodeById.has(entity.id)) {
      setSelectedId(entity.id);
      document.getElementById('graph-canvas-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setSelectedId(null);
    }
  };

  const topType = typeCounts[0] ?? graph?.stats.topTypes?.[0];
  const hasPerson = Boolean(personRef);

  return (
    <div className="page">
      <PageHead
        eyebrow="图谱 · 实体与关系"
        title="实体关系图"
        desc="由写入管线的实体抽取（extract 任务）生成：节点=实体、边=同一记忆内的共现关系（co_occurs）。支持分区级与可选人级视图。"
        actions={
          <>
            <Button icon="refresh" loading={graphQuery.loading} onClick={refreshAll}>
              刷新
            </Button>
          </>
        }
      />

      <div className="grid grid-4">
        <Stat
          label="实体节点"
          value={graphQuery.loading && !graph ? <Skeleton w={54} h={22} /> : fmtInt(graph?.stats.nodes ?? nodes.length)}
          icon="graph"
          tone="violet"
          hint={`当前视图上限 ${fmtInt(nodeLimit)} 个节点`}
        />
        <Stat
          label="关系边"
          value={graphQuery.loading && !graph ? <Skeleton w={54} h={22} /> : fmtInt(graph?.stats.edges ?? edges.length)}
          icon="link"
          tone="cyan"
          hint="co_occurs：同一记忆内实体两两共现"
        />
        <Stat
          label="类型 Top"
          value={
            topType ? (
              <span className="hstack gap-6" style={{ alignItems: 'baseline' }}>
                {entityTypeMeta(topType.type).label}
                <span className="tiny dim">×{fmtInt(topType.count)}</span>
              </span>
            ) : (
              '—'
            )
          }
          icon="tag"
          tone="amber"
          hint={typeCounts.length ? `共 ${fmtInt(typeCounts.length)} 种类型，按节点数排序` : '暂无实体类型'}
        />
        <Stat
          label="视角"
          value={hasPerson ? <span className="mono truncate" title={personRef}>{personRef}</span> : '全分区'}
          icon="user"
          tone="green"
          hint={hasPerson ? '人级子图：只统计该人记忆产生的实体/关系' : '可选人筛选缩小到某人的记忆'}
        />
      </div>

      <Card>
        <div style={{ padding: '14px 16px' }}>
          <div className="toolbar">
            <div className="toolbar-left">
              <Input
                value={personInput}
                onChange={(event) => setPersonInput(event.target.value)}
                placeholder="按人筛选：external ID / 内部 ID（可选）"
                style={{ width: 260 }}
                aria-label="按人筛选图谱"
              />
              <Select
                options={LIMIT_OPTIONS}
                value={limit}
                aria-label="节点数量上限"
                style={{ width: 160 }}
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>
            <div className="toolbar-right">
              {hasPerson || q || typeFilter ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  onClick={() => {
                    setPersonInput('');
                    setQ('');
                    setTypeFilter('');
                    setSelectedId(null);
                  }}
                >
                  清空筛选
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" icon="refresh" loading={graphQuery.loading || entitiesQuery.loading} onClick={refreshAll}>
                刷新数据
              </Button>
            </div>
          </div>
          <div className="tiny dim mt-8">
            图与实体列表都按人/分区维度查询；「按人筛选」会校验人是否存在。实体由异步 extract 任务生成，新写入的记忆可能需要几秒后出现在图中。
          </div>
        </div>
      </Card>

      <div id="graph-canvas-anchor">
        <Card pad>
          <div className="between wrap gap-10">
            <div>
              <div className="section-title">关系图</div>
              <div className="tiny dim mt-4">
                圆形近似布局：节点越大权重越高（关联记忆 salience 累计）；点击节点高亮相邻边与邻居，点空白取消。
              </div>
            </div>
            <div className="hstack gap-6 wrap">
              {typeCounts.length ? (
                typeCounts.slice(0, 6).map((item) => (
                  <Badge key={item.type} tone={entityTypeMeta(item.type).tone} size="sm">
                    {entityTypeMeta(item.type).label} {fmtInt(item.count)}
                  </Badge>
                ))
              ) : null}
              <Badge tone="slate" size="sm">节点 {fmtInt(nodes.length)} · 边 {fmtInt(edges.length)}</Badge>
            </div>
          </div>

          {graphQuery.loading && !graph ? (
            <div className="mt-12">
              <Skeleton h={420} style={{ borderRadius: 12 }} />
            </div>
          ) : graphQuery.error && !graph ? (
            <div className="mt-12">
              <ErrorState message={graphQuery.error} onRetry={() => void graphQuery.refresh()} />
              {hasPerson ? (
                <Callout tone="amber" icon="info">
                  人筛选可能指向不存在的人（ref: <span className="mono">{personRef}</span>）。清空筛选可回到分区级图谱。
                </Callout>
              ) : (
                <Callout tone="amber" icon="info">
                  图谱接口可能尚未就绪（GET <span className="mono">/api/partitions/:p/graph</span>）；确认 P2 后端已启动后重试。
                </Callout>
              )}
            </div>
          ) : nodes.length === 0 ? (
            <div className="mt-12">
              <EmptyState
                icon="graph"
                title="还没有可展示的实体"
                description={
                  hasPerson
                    ? '该人的记忆还没有抽取到实体。换个人或清空人筛选试试。'
                    : '写入记忆后，异步 extract 任务会抽取实体与共现关系。确认分区设置里「自动抽取实体」已开启。'
                }
              />
            </div>
          ) : (
            <>
              {graphQuery.error ? (
                <div className="mt-10">
                  <Callout tone="amber" icon="alert">刷新图谱失败，已保留上次结果：{graphQuery.error}</Callout>
                </div>
              ) : null}
              <div className="mt-12">
                <GraphCanvas nodes={nodes} edges={edges} selectedId={selectedId} onSelect={setSelectedId} />
              </div>
              <div className="between wrap gap-8 mt-8">
                <span className="tiny dim">
                  {selectedNode ? (
                    <>
                      已选中 <span className="mono">{selectedNode.label}</span>（{entityTypeMeta(selectedNode.type).label}）·
                      相邻 {fmtInt(neighborCount)} 条边
                    </>
                  ) : (
                    `${fmtInt(nodes.length)} 个节点 / ${fmtInt(edges.length)} 条边`
                  )}
                </span>
                {selectedNode ? (
                  <Button size="sm" variant="ghost" icon="x" onClick={() => setSelectedId(null)}>
                    取消选中
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card pad>
          <SectionHead
            title="实体列表"
            desc="服务端按关联记忆数 / mentionCount 排序；名称搜索与类型筛选只作用于本列表。"
            actions={<Badge tone="slate" size="sm">{fmtInt(filteredEntities.length)}{typeFilter ? ` / ${fmtInt(entities.length)}` : ''}</Badge>}
          />
          <div className="toolbar mt-10">
            <div className="toolbar-left">
              <SearchInput value={q} onChange={setQ} placeholder="搜索实体名称（服务端 LIKE）" />
              <Select
                options={typeOptions}
                value={typeFilter}
                aria-label="按实体类型筛选"
                style={{ width: 148 }}
                onChange={(event) => setTypeFilter(event.target.value)}
              />
            </div>
            {q || typeFilter ? (
              <div className="toolbar-right">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  onClick={() => {
                    setQ('');
                    setTypeFilter('');
                  }}
                >
                  清空列表筛选
                </Button>
              </div>
            ) : null}
          </div>
          <div className="mt-12">
            {entitiesQuery.loading && entities.length === 0 ? (
              <div className="vstack gap-8">
                {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={40} style={{ borderRadius: 8 }} />)}
              </div>
            ) : entitiesQuery.error && entities.length === 0 ? (
              <ErrorState message={entitiesQuery.error} onRetry={() => void entitiesQuery.refresh()} />
            ) : filteredEntities.length === 0 ? (
              <EmptyState
                compact
                icon="tag"
                title={entities.length ? '没有符合类型筛选的实体' : q ? '没有匹配的实体' : '暂无实体'}
                description={
                  entities.length
                    ? '切换类型筛选或清空筛选后再试。'
                    : '实体由写入管线的 extract 任务生成；写入记忆后稍等再刷新。'
                }
              />
            ) : (
              <Table
                rows={filteredEntities}
                rowKey={(entity) => entity.id}
                onRowClick={selectEntity}
                empty={<EmptyState compact icon="tag" title="暂无实体" />}
                columns={[
                  {
                    key: 'name',
                    header: '实体',
                    render: (entity) => (
                      <div className="vstack gap-2" style={{ minWidth: 0 }}>
                        <span className="truncate" title={entity.name}>{entity.name}</span>
                        <span className="tiny dim mono" title={entity.id}>{truncateMiddle(entity.id, 8, 4)}</span>
                      </div>
                    ),
                  },
                  {
                    key: 'type',
                    header: '类型',
                    width: 88,
                    render: (entity) => (
                      <Badge tone={entityTypeMeta(entity.type).tone} size="sm">
                        {entityTypeMeta(entity.type).label}
                      </Badge>
                    ),
                  },
                  {
                    key: 'mentionCount',
                    header: '提及',
                    width: 72,
                    align: 'right',
                    render: (entity) => <span className="mono">{fmtInt(entity.mentionCount)}</span>,
                  },
                  {
                    key: 'memories',
                    header: '记忆',
                    width: 72,
                    align: 'right',
                    render: (entity) => <span className="mono">{fmtInt(entity.memories)}</span>,
                  },
                  {
                    key: 'action',
                    header: '',
                    width: 76,
                    render: (entity) =>
                      nodeById.has(entity.id) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="graph"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectEntity(entity);
                          }}
                        >
                          定位
                        </Button>
                      ) : (
                        <span className="tiny dim">不在图中</span>
                      ),
                  },
                ]}
              />
            )}
          </div>
          {entitiesQuery.error && entities.length > 0 ? (
            <Callout tone="amber" icon="alert">刷新实体列表失败，已保留上次结果：{entitiesQuery.error}</Callout>
          ) : null}
        </Card>

        <Card pad>
          <SectionHead
            title="关系边"
            desc="同一记忆内共现的实体对（co_occurs）；点击行可高亮源节点。"
            actions={
              <div className="hstack gap-8">
                <Switch
                  checked={adjacentOnly}
                  disabled={!selectedId}
                  label={selectedNode ? '只看选中节点的边' : '只看相邻（需先选中节点）'}
                  onChange={setAdjacentOnly}
                />
                <Badge tone="slate" size="sm">{fmtInt(edgeRows.length)} / {fmtInt(edges.length)}</Badge>
              </div>
            }
          />
          <div className="mt-12">
            {graphQuery.loading && !graph ? (
              <div className="vstack gap-8">
                {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={40} style={{ borderRadius: 8 }} />)}
              </div>
            ) : edges.length === 0 ? (
              <EmptyState
                compact
                icon="link"
                title="还没有关系边"
                description="同一记忆里至少需要两个实体才会生成共现关系。"
              />
            ) : edgeRows.length === 0 ? (
              <EmptyState
                compact
                icon="filter"
                title="选中节点没有相邻边"
                description="取消「只看选中节点的边」或选择其他节点。"
              />
            ) : (
              <Table
                rows={edgeRows}
                rowKey={(edge) => edge.id}
                onRowClick={(edge) => setSelectedId(edge.source)}
                columns={[
                  {
                    key: 'source',
                    header: '实体对',
                    render: (edge) => (
                      <div className="vstack gap-2" style={{ minWidth: 0 }}>
                        <span className="truncate" title={`${nodeLabel(edge.source)} → ${nodeLabel(edge.target)}`}>
                          {nodeLabel(edge.source)} → {nodeLabel(edge.target)}
                        </span>
                        <span className="tiny dim">{edge.relation}</span>
                      </div>
                    ),
                  },
                  {
                    key: 'weight',
                    header: '权重',
                    width: 64,
                    align: 'right',
                    render: (edge) => <span className="mono">{edge.weight}</span>,
                  },
                  {
                    key: 'actions',
                    header: '',
                    width: 76,
                    render: (edge) => (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="eye"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(edge.source);
                        }}
                      >
                        高亮
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </div>
          {edges.length > MAX_EDGE_ROWS ? (
            <div className="tiny dim mt-8">
              仅展示前 {MAX_EDGE_ROWS} 条边（共 {fmtInt(edges.length)} 条）；可降低节点上限或选中节点缩小范围。
            </div>
          ) : null}
        </Card>
      </div>

      <Callout tone="slate" icon="info">
        图谱数据与实体列表均为只读视图：由 <span className="mono">entities / memory_entities / relations</span> 表生成，
        随记忆写入（异步 extract）与删除自动维护；PII 脱敏在写入时生效，图中看到的是脱敏后的实体名。
      </Callout>
    </div>
  );
}
