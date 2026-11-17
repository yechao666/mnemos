import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Memory } from '@lib/types.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  CopyButton,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingBlock,
  PageHead,
  Skeleton,
  Stat,
  useToast,
} from '@ui';
import { api, isNotFoundError } from '@lib/api.ts';
import { useAsync, useCursorList } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative, truncateMiddle } from '@lib/format.ts';
import { ROLE_RANK } from '@lib/constants.ts';
import { BriefCard } from '../components/brief/BriefCard.tsx';
import { DreamCard } from '../components/brief/DreamCard.tsx';
import { MemoryContent, MemoryMeta } from '../components/memories/shared.tsx';
import { MemoryDrawer } from '../components/memories/MemoryDrawer.tsx';
import {
  PersonExternalIdChip,
  PersonStatusBadge,
  PersonTypeBadge,
  personAttributeEntries,
  personDisplayName,
  personTone,
} from '../components/persons/shared.tsx';
import { usePartitionContext } from '@lib/partition-context.tsx';

/**
 * 人详情：资料头 + 行内计数 + 最近记忆（游标加载更多）+ 人级简报 + 做梦状态（按需）+ 上下文预览（按需）。
 * 记忆不一次全量加载；简报/做梦/上下文各自独立请求与错误态，互不阻塞。
 */
export function PersonDetailPage() {
  const { partitionId = '', personRef = '' } = useParams<{ partitionId: string; personRef: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { partition } = usePartitionContext();

  const personQuery = useAsync(
    () => api.persons.get(partitionId, personRef),
    [partitionId, personRef],
    Boolean(partitionId && personRef),
  );
  const person = personQuery.data;

  // 人级简报按需读取：首次读取走缓存，force=true 才重新生成。
  const briefQuery = useAsync(
    () => api.persons.brief(partitionId, personRef),
    [partitionId, personRef],
    Boolean(partitionId && personRef),
  );

  const memories = useCursorList<Memory>(
    (cursor) => api.persons.memories(partitionId, personRef, { cursor, limit: 10 }),
    [partitionId, personRef],
    Boolean(partitionId && personRef),
  );

  // 做梦状态与上下文都按需：用户点开才发请求。
  const [dreamLoaded, setDreamLoaded] = useState(false);
  const dreamQuery = useAsync(
    () => api.persons.dream(partitionId, personRef),
    [partitionId, personRef, dreamLoaded],
    Boolean(partitionId && personRef) && dreamLoaded,
  );

  const [contextOpen, setContextOpen] = useState(false);
  const contextQuery = useAsync(
    () => api.persons.context(partitionId, personRef, {}),
    [partitionId, personRef, contextOpen],
    Boolean(partitionId && personRef) && contextOpen,
  );

  const [running, setRunning] = useState(false);
  const [drawerMemory, setDrawerMemory] = useState<Memory | null>(null);
  const canManage = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);

  const openMemoryById = async (id: string) => {
    if (!id) return;
    const known = memories.items.find((memory) => memory.id === id);
    if (known) {
      setDrawerMemory(known);
      return;
    }
    try {
      setDrawerMemory(await api.memories.get(partitionId, id));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法加载关联记忆');
    }
  };

  const refreshPerson = () => {
    void personQuery.refresh();
    void briefQuery.refresh();
    void memories.refresh();
    if (dreamLoaded) void dreamQuery.refresh();
    if (contextOpen) void contextQuery.refresh();
  };

  const runDream = async () => {
    if (running) return;
    setRunning(true);
    try {
      const result = await api.persons.runDream(partitionId, personRef);
      if (!result.run || result.run.status === 'skipped') {
        toast.info('该人没有需要整理的新记忆');
      } else {
        toast.success(`人级做梦完成：${fmtInt(result.run.inputCount)} 条新记忆 → ${fmtInt(result.run.insightCount)} 条洞见`);
      }
      setDreamLoaded(true);
      await Promise.all([dreamQuery.refresh(), briefQuery.refresh(), memories.refresh(), personQuery.refresh()]);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '人级做梦失败');
    } finally {
      setRunning(false);
    }
  };

  if (!partitionId || !personRef) {
    return (
      <div className="page">
        <PageHead
          eyebrow="人"
          title="缺少人标识"
          desc="当前地址未包含分区或人的标识，请从人列表重新进入。"
          actions={<Button icon="chevronLeft" onClick={() => navigate(`/partitions/${partitionId}/persons`)}>返回人列表</Button>}
        />
        <Card pad>
          <ErrorState message="人的标识缺失，无法加载详情。" />
        </Card>
      </div>
    );
  }

  const attributeEntries = personAttributeEntries(person);
  const apiNotReady = isNotFoundError(personQuery.error);

  return (
    <div className="page">
      <PageHead
        eyebrow="人 · 记忆主体"
        title={person ? personDisplayName(person) : '人详情'}
        desc={
          person
            ? `${person.externalId} · ${person.type === 'human' ? '真人' : person.type === 'agent' ? '智能体' : person.type === 'service' ? '服务' : '其他'}`
            : '人的资料、记忆与上下文。'
        }
        actions={
          <>
            <Button icon="chevronLeft" onClick={() => navigate(`/partitions/${partitionId}/persons`)}>
              返回人列表
            </Button>
            <Button
              variant="secondary"
              icon="brain"
              onClick={() =>
                navigate(
                  `/partitions/${partitionId}/memories?person=${encodeURIComponent(person?.externalId ?? personRef)}`,
                )
              }
            >
              记忆浏览器
            </Button>
            <IconButton icon="refresh" label="刷新人详情" disabled={personQuery.loading} onClick={refreshPerson} />
          </>
        }
      />

      {apiNotReady ? (
        <Callout tone="amber" icon="info">
          人详情接口尚未就绪（404）或该人在分区中不存在：后端上线后点击「重试」即可加载，页面其他部分不受影响。
        </Callout>
      ) : null}

      {personQuery.loading && !person ? (
        <Card pad>
          <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
            <Skeleton w={56} h={56} style={{ borderRadius: 16 }} />
            <div className="vstack gap-8" style={{ flex: 1 }}>
              <Skeleton w={200} h={20} />
              <Skeleton w={280} h={12} />
              <Skeleton w="52%" h={12} />
            </div>
          </div>
        </Card>
      ) : personQuery.error && !person ? (
        <Card pad>
          <div className="vstack gap-10">
            <ErrorState message={personQuery.error} onRetry={() => void personQuery.refresh()} />
            {isNotFoundError(personQuery.error) ? (
              <Callout tone="amber" icon="info">
                接口未就绪或该人不存在（ref: <span className="mono">{personRef}</span>）。
              </Callout>
            ) : null}
          </div>
        </Card>
      ) : person ? (
        <>
          <Card pad className="person-profile">
            <div className="person-profile-head">
              <Avatar name={personDisplayName(person)} tone={personTone(person)} size="lg" square />
              <div className="person-profile-main">
                <div className="hstack gap-8 wrap">
                  <span className="person-profile-name">{personDisplayName(person)}</span>
                  <PersonTypeBadge type={person.type} />
                  <PersonStatusBadge status={person.status} />
                </div>
                <div className="hstack gap-8 wrap mt-8">
                  <PersonExternalIdChip externalId={person.externalId} />
                  <span className="tiny dim mono" title={person.id}>内部 ID {truncateMiddle(person.id, 10, 6)}</span>
                  <CopyButton value={person.externalId} label="复制 external ID" />
                </div>
                <div className="hstack gap-12 wrap tiny dim mt-8">
                  <span title={person.firstSeenAt}>首次出现 {fmtRelative(person.firstSeenAt)}</span>
                  <span title={person.lastSeenAt}>最近活跃 {fmtRelative(person.lastSeenAt)}</span>
                  <span title={person.updatedAt}>资料更新 {fmtRelative(person.updatedAt)}</span>
                  <span>所属分区 {partition?.name ?? partitionId}</span>
                </div>
              </div>
            </div>

            {attributeEntries.length ? (
              <>
                <div className="divider mt-16" />
                <div className="person-attr-grid">
                  {attributeEntries.map((entry) => (
                    <div key={entry.key} className="person-attr">
                      <span className="person-attr-key" title={entry.key}>{entry.key}</span>
                      <span className="person-attr-value mono" title={entry.value}>{entry.value}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="tiny dim mt-12">暂无扩展属性（attributes）。调用方可写入角色、模型、标签、画像等自由字段。</div>
            )}
          </Card>

          <div className="grid grid-4">
            <Stat label="记忆" value={fmtInt(person.memoryCount)} icon="brain" tone="violet" hint="归属该人（person + session）" />
            <Stat label="共享记忆" value={fmtInt(person.sharedMemoryCount)} icon="users" tone="green" hint="scope=partition 的共享知识" />
            <Stat label="会话" value={fmtInt(person.sessionCount)} icon="branch" tone="cyan" hint="参与过的 session 数" />
            <Stat
              label="最近记忆"
              value={person.lastMemoryAt ? fmtRelative(person.lastMemoryAt) : '—'}
              icon="clock"
              tone="amber"
              hint={person.lastMemoryAt ? fmtFullDateTime(person.lastMemoryAt) : '尚未写入记忆'}
            />
          </div>

          <Card pad>
            <div className="between wrap gap-10">
              <div>
                <div className="section-title">最近记忆</div>
                <div className="tiny dim mt-4">按人筛选的最近记忆，游标分页每次加载 10 条；scope 区分仅本人 / 共享 / 仅会话。</div>
              </div>
              <div className="hstack gap-8">
                <Badge tone="slate" size="sm">已加载 {fmtInt(memories.items.length)} 条</Badge>
                {memories.hasMore ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="chevronDown"
                    loading={memories.loadingMore}
                    onClick={() => void memories.loadMore()}
                  >
                    加载更多
                  </Button>
                ) : null}
                <IconButton icon="refresh" label="刷新最近记忆" size="sm" disabled={memories.loading} onClick={() => void memories.refresh()} />
              </div>
            </div>

            {memories.error && memories.items.length > 0 ? (
              <div className="mt-12">
                <Callout tone="amber" icon="alert">加载更多失败，已保留已加载的记忆：{memories.error}</Callout>
              </div>
            ) : null}

            {memories.loading && memories.items.length === 0 ? (
              <div className="vstack gap-10 mt-12">
                {[0, 1, 2].map((index) => <Skeleton key={index} h={54} style={{ borderRadius: 10 }} />)}
              </div>
            ) : memories.error && memories.items.length === 0 ? (
              <div className="mt-12">
                <ErrorState message={memories.error} onRetry={() => void memories.refresh()} />
              </div>
            ) : memories.items.length === 0 ? (
              <div className="mt-12">
                <EmptyState
                  compact
                  icon="brain"
                  title="该人还没有记忆"
                  description="调用方以该人的 external id 写入记忆后，这里会按时间线展示。"
                />
              </div>
            ) : (
              <div className="vstack gap-8 mt-12">
                {memories.items.map((memory) => (
                  <div
                    key={memory.id}
                    className="v6-memory-row is-clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDrawerMemory(memory)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDrawerMemory(memory);
                      }
                    }}
                  >
                    <div className="between wrap gap-8">
                      <MemoryContent memory={memory} clamp />
                      <span className="tiny dim nowrap" title={fmtFullDateTime(memory.updatedAt)}>
                        {fmtRelative(memory.updatedAt)}
                      </span>
                    </div>
                    <div className="mt-4">
                      <MemoryMeta memory={memory} onOpenSuperseded={(id) => void openMemoryById(id)} />
                    </div>
                  </div>
                ))}
                {memories.hasMore ? (
                  <div className="center mt-8">
                    <Button size="sm" variant="ghost" icon="chevronDown" loading={memories.loadingMore} onClick={() => void memories.loadMore()}>
                      加载更早的记忆
                    </Button>
                  </div>
                ) : (
                  <div className="center tiny dim mt-4">已加载全部记忆</div>
                )}
              </div>
            )}
          </Card>

          <BriefCard
            brief={briefQuery.data}
            loading={briefQuery.loading}
            error={briefQuery.error}
            onRefresh={(force) => {
              if (force) {
                void api.persons.brief(partitionId, personRef, { force: true }).then(
                  (brief) => briefQuery.setData(brief),
                  (cause: unknown) => toast.error(cause instanceof Error ? cause.message : '重新生成简报失败'),
                );
              } else {
                void briefQuery.refresh();
              }
            }}
            title="人的记忆简报"
            desc="只聚合该人 scope=person 记忆 + 与其相关的分区共享记忆，可直接注入提示词。"
            badge={<Badge tone="cyan" size="sm">人级</Badge>}
            emptyHint="该人还没有可用于简报的记忆。写入记忆后重新生成。"
          />

          <DreamCard
            status={dreamQuery.data}
            loading={dreamQuery.loading}
            error={dreamQuery.error}
            running={running}
            canManage={canManage}
            onLoad={() => setDreamLoaded(true)}
            onRun={() => void runDream()}
            onRefresh={() => void dreamQuery.refresh()}
            title="人级做梦"
            desc="只巩固该人 scope=person 的新记忆；洞见写回该人。"
            badge={<Badge tone="cyan" size="sm">人级</Badge>}
          />

          <Card pad>
            <div className="between wrap gap-10">
              <div>
                <div className="section-title">人的上下文</div>
                <div className="tiny dim mt-4">资料 + 人级简报 + 高相关记忆 +（可选）分区共享知识，返回可直接注入的 prompt。</div>
              </div>
              <div className="hstack gap-8">
                {contextOpen && contextQuery.data ? (
                  <IconButton icon="refresh" label="重新生成上下文" size="sm" disabled={contextQuery.loading} onClick={() => void contextQuery.refresh()} />
                ) : null}
                <Button
                  size="sm"
                  variant={contextOpen ? 'ghost' : 'secondary'}
                  icon={contextOpen ? 'chevronUp' : 'chevronDown'}
                  onClick={() => setContextOpen((value) => !value)}
                >
                  {contextOpen ? '收起' : '展开预览'}
                </Button>
              </div>
            </div>

            {!contextOpen ? (
              <div className="tiny dim mt-8">
                展开后生成一次上下文预览（POST <span className="mono">/persons/:person/context</span>），不阻塞首屏。
              </div>
            ) : contextQuery.loading && !contextQuery.data ? (
              <div className="mt-12">
                <LoadingBlock label="正在生成人的上下文…" />
              </div>
            ) : contextQuery.error && !contextQuery.data ? (
              <div className="mt-12">
                <ErrorState message={contextQuery.error} onRetry={() => void contextQuery.refresh()} />
              </div>
            ) : contextQuery.data ? (
              <div className="vstack gap-12 mt-12">
                <div className="chip-row">
                  <Badge size="sm" tone="violet" dot>记忆 {fmtInt(contextQuery.data.memories.length)}</Badge>
                  <Badge size="sm" tone="green" dot>共享 {fmtInt(contextQuery.data.shared.length)}</Badge>
                  <Badge size="sm" tone="cyan" dot>简报 {fmtInt(contextQuery.data.brief?.count ?? 0)} 条</Badge>
                  <span className="chip mono">≈ {fmtInt(contextQuery.data.tokenEstimate)} tokens</span>
                  {contextQuery.data.builtAt ? (
                    <span className="tiny dim" title={contextQuery.data.builtAt}>生成于 {fmtRelative(contextQuery.data.builtAt)}</span>
                  ) : null}
                </div>
                <CodeBlock code={contextQuery.data.prompt || '（暂无可用内容）'} title="可注入提示词 · prompt" language="markdown" />
                {contextQuery.data.citations.length ? (
                  <div className="chip-row">
                    <span className="tiny dim">引用</span>
                    {contextQuery.data.citations.slice(0, 8).map((citation) => (
                      <span key={citation} className="chip mono" title={citation}>{truncateMiddle(citation, 8, 6)}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-12">
                <EmptyState compact icon="terminal" title="暂无上下文" description="写入记忆后重试。" />
              </div>
            )}
          </Card>
        </>
      ) : null}

      <MemoryDrawer
        open={Boolean(drawerMemory)}
        partitionId={partitionId}
        memory={drawerMemory}
        canManage={canManage}
        onClose={() => setDrawerMemory(null)}
        onOpenMemory={(id) => void openMemoryById(id)}
        onChanged={() => {
          void memories.refresh();
          void personQuery.refresh();
        }}
      />
    </div>
  );
}
