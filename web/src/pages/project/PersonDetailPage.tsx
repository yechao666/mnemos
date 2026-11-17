import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Memory } from '@shared';
import { PAGE_SIZE, ROLE_RANK } from '@shared';
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
  Icon,
  IconButton,
  LoadingBlock,
  PageHead,
  Pagination,
  SectionHead,
  Skeleton,
  Stat,
  useToast,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative, truncateMiddle } from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { MemoryContent, SOURCE_LABEL } from '../../components/project/shared.tsx';
import { MemoryBriefCard } from '../../components/project/memory/MemoryBriefCard.tsx';
import { DreamStatusCard } from '../../components/project/memory/DreamStatusCard.tsx';
import { DreamRunsModal } from '../../components/project/memory/DreamRunsModal.tsx';
import { isNotFoundError } from '../../components/project/agent/shared.tsx';
import {
  PersonExternalIdChip,
  PersonStatusBadge,
  PersonTypeBadge,
  ScopeBadge,
  personAttributeEntries,
  personDisplayName,
  personTone,
  scopeOf,
} from '../../components/project/person/shared.tsx';

/**
 * 人（Person）详情：资料 + 统计 + 记忆时间线 + 人级简报 + 人级做梦 + 上下文预览。
 * 人级接口可能尚未上线（404），此时各卡片独立展示错误与重试，不影响页面其它区块。
 */
export function PersonDetailPage() {
  const { projectId = '', personRef = '' } = useParams<{ projectId: string; personRef: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { project } = useProjectContext();
  const ref = personRef;

  const personAsync = useAsync(
    () => api.persons.get(projectId, ref),
    [projectId, ref],
    Boolean(projectId && ref),
  );
  const person = personAsync.data;

  const briefAsync = useAsync(
    () => api.personBrief(projectId, ref),
    [projectId, ref],
    Boolean(projectId && ref),
  );
  const dreamAsync = useAsync(
    () => api.persons.dream(projectId, ref),
    [projectId, ref],
    Boolean(projectId && ref),
  );

  const [page, setPage] = useState(1);
  const memoriesAsync = useAsync(
    () =>
      api.memories.list(projectId, {
        personId: ref,
        includePrivate: true,
        page,
        pageSize: PAGE_SIZE,
      }),
    [projectId, ref, page],
    Boolean(projectId && ref),
  );
  const insightAsync = useAsync(
    () =>
      api.memories
        .list(projectId, {
          personId: ref,
          category: 'insight',
          pageSize: 1,
          includePrivate: true,
        })
        .then((result) => result.total),
    [projectId, ref],
    Boolean(projectId && ref),
  );

  // 人级上下文按需生成：展开后才发请求，避免每条人详情都跑一次上下文构建。
  const [contextOpen, setContextOpen] = useState(false);
  const contextAsync = useAsync(
    () => api.personContext(projectId, ref, {}),
    [projectId, ref, contextOpen],
    Boolean(projectId && ref) && contextOpen,
  );

  const [runsOpen, setRunsOpen] = useState(false);
  const [dreaming, setDreaming] = useState(false);

  // 写接口（人级做梦 / 简报刷新）要求项目管理员：组织管理员直接放行，其余读项目成员角色。
  const isOrgAdmin = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);
  const membersAsync = useAsync(
    () => api.projects.members.list(projectId),
    [projectId, isOrgAdmin, user?.id],
    Boolean(projectId) && Boolean(user) && !isOrgAdmin,
  );
  const memberRole = membersAsync.data?.find((member) => member.userId === user?.id)?.role ?? null;
  const effectiveRole = user ? (isOrgAdmin ? user.role : memberRole) : null;
  const canManage = effectiveRole === 'admin' || effectiveRole === 'owner';

  const rawRows = useMemo(() => memoriesAsync.data?.items ?? [], [memoriesAsync.data]);
  // 后端按人筛选就绪前，列表可能返回分区全部记忆：有 person 标记时在前端兜底过滤。
  const rows = useMemo(() => {
    if (!person) return rawRows;
    const hasPersonMarker = rawRows.some((memory) => memory.personId || memory.personExternalId);
    if (!hasPersonMarker) return rawRows;
    return rawRows.filter(
      (memory) =>
        memory.personId === person.id || memory.personExternalId === person.externalId,
    );
  }, [rawRows, person]);
  const filterFallback = rawRows.length > 0 && rows.length !== rawRows.length;
  const filterUnready =
    Boolean(person) &&
    rawRows.length > 0 &&
    !rawRows.some((memory) => memory.personId || memory.personExternalId);

  const attributeEntries = useMemo(() => personAttributeEntries(person), [person]);
  const stats = person?.stats;
  const total = memoriesAsync.data?.total ?? 0;
  const totalPages = memoriesAsync.data?.totalPages ?? 1;

  const pendingErrors = [personAsync.error, briefAsync.error, dreamAsync.error, memoriesAsync.error]
    .filter((message): message is string => Boolean(message));
  const apiNotReady = pendingErrors.some((message) => isNotFoundError(message));

  const refreshAll = () => {
    void personAsync.refresh();
    void briefAsync.refresh();
    void dreamAsync.refresh();
    void memoriesAsync.refresh();
    void insightAsync.refresh();
  };

  const runDream = async () => {
    if (!projectId || dreaming) return;
    setDreaming(true);
    try {
      const result = await api.persons.runDream(projectId, ref);
      const run = result.run;
      if (!run || run.status === 'skipped') {
        toast.info('该人没有需要整理的新记忆');
      } else {
        toast.success(
          `人级复盘完成：${fmtInt(run.inputCount)} 条新记忆 → ${fmtInt(run.insightCount)} 条洞见`,
        );
      }
      await Promise.all([
        dreamAsync.refresh(),
        briefAsync.refresh(),
        memoriesAsync.refresh(),
        insightAsync.refresh(),
        personAsync.refresh(),
      ]);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '人级复盘总结失败');
    } finally {
      setDreaming(false);
    }
  };

  if (!projectId || !ref) {
    return (
      <div className="page">
        <PageHead
          eyebrow="人"
          title="缺少人标识"
          desc="当前地址未包含项目或人的标识，请从人列表重新进入。"
          actions={
            <Button icon="chevronLeft" onClick={() => navigate(`/projects/${projectId}/persons`)}>
              返回人列表
            </Button>
          }
        />
        <Card pad>
          <ErrorState message="人的标识缺失，无法加载详情。" />
        </Card>
      </div>
    );
  }

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
            <Button icon="chevronLeft" onClick={() => navigate(`/projects/${projectId}/persons`)}>
              返回人列表
            </Button>
            <Button
              variant="secondary"
              icon="brain"
              onClick={() =>
                navigate(
                  `/projects/${projectId}/memories?person=${encodeURIComponent(
                    person?.externalId ?? ref,
                  )}`,
                )
              }
            >
              记忆浏览器
            </Button>
            <IconButton
              icon="refresh"
              label="刷新人详情"
              disabled={personAsync.loading}
              onClick={refreshAll}
            />
          </>
        }
      />

      {apiNotReady ? (
        <Callout tone="amber" icon="info">
          部分人级接口尚未就绪（404）：后端实现完成后点击各卡片的「重试」即可加载，页面其他部分不受影响。
        </Callout>
      ) : null}

      {personAsync.loading && !person ? (
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
      ) : personAsync.error && !person ? (
        <Card pad>
          <div className="vstack gap-10">
            <ErrorState message={personAsync.error} onRetry={() => void personAsync.refresh()} />
            {isNotFoundError(personAsync.error) ? (
              <Callout tone="amber" icon="info">
                人详情接口尚未就绪时会返回 404；也可能是该人在分区中不存在（ref: <span className="mono">{ref}</span>）。
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
                  <span className="tiny dim mono" title={person.id}>
                    内部 ID {truncateMiddle(person.id, 10, 6)}
                  </span>
                  <CopyButton value={person.externalId} label="复制 external ID" />
                </div>
                <div className="hstack gap-12 wrap tiny dim mt-8">
                  <span title={fmtFullDateTime(person.firstSeenAt)}>
                    首次出现 {fmtRelative(person.firstSeenAt)}
                  </span>
                  <span title={fmtFullDateTime(person.lastSeenAt)}>
                    最近活跃 {fmtRelative(person.lastSeenAt)}
                  </span>
                  <span title={fmtFullDateTime(person.updatedAt)}>
                    资料更新 {fmtRelative(person.updatedAt)}
                  </span>
                  <span>所属分区 {project?.name ?? projectId}</span>
                </div>
              </div>
            </div>

            {attributeEntries.length ? (
              <>
                <div className="divider mt-16" />
                <div className="person-attr-grid">
                  {attributeEntries.map((entry) => (
                    <div key={entry.key} className="person-attr">
                      <span className="person-attr-key" title={entry.key}>
                        {entry.key}
                      </span>
                      <span className="person-attr-value mono" title={entry.value}>
                        {entry.value}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="tiny dim mt-12">
                暂无扩展属性（attributes）。调用方可写入角色、模型、标签、画像等自由字段。
              </div>
            )}
          </Card>

          <div className="grid grid-4">
            <Stat
              label="记忆"
              value={fmtInt(stats?.memories ?? 0)}
              icon="brain"
              tone="violet"
              hint="归属该人的记忆"
            />
            <Stat
              label="共享记忆"
              value={fmtInt(stats?.sharedMemories ?? 0)}
              icon="users"
              tone="green"
              hint="scope=partition 的共享知识"
            />
            <Stat
              label="会话"
              value={fmtInt(stats?.sessions ?? 0)}
              icon="branch"
              tone="cyan"
              hint="参与过的 session 数"
            />
            <Stat
              label="最近记忆"
              value={stats?.lastMemoryAt ? fmtRelative(stats.lastMemoryAt) : '—'}
              icon="clock"
              tone="amber"
              hint={stats?.lastMemoryAt ? fmtFullDateTime(stats.lastMemoryAt) : '尚未写入记忆'}
            />
          </div>

          <Card pad>
            <SectionHead
              title="记忆时间线"
              desc="按人筛选的最近记忆；仅本人 / 分区共享 / 仅会话由 scope 区分。"
              actions={
                <IconButton
                  icon="refresh"
                  label="刷新记忆时间线"
                  size="sm"
                  disabled={memoriesAsync.loading}
                  onClick={() => void memoriesAsync.refresh()}
                />
              }
            />

            {filterFallback ? (
              <div className="mt-12">
                <Callout tone="amber" icon="alert">
                  后端按人筛选尚未生效，当前页面已在前端按 person 标记过滤，分页条数可能不完整。
                </Callout>
              </div>
            ) : filterUnready ? (
              <div className="mt-12">
                <Callout tone="amber" icon="info">
                  后端返回的记忆还没有 person 归属字段，暂时无法确认哪些记忆属于「{personDisplayName(person)}」。
                </Callout>
              </div>
            ) : null}

            {memoriesAsync.loading && !memoriesAsync.data ? (
              <div className="vstack gap-10 mt-12">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} h={46} style={{ borderRadius: 10 }} />
                ))}
              </div>
            ) : memoriesAsync.error && !memoriesAsync.data ? (
              <div className="mt-12">
                <ErrorState
                  message={memoriesAsync.error}
                  onRetry={() => void memoriesAsync.refresh()}
                />
              </div>
            ) : rows.length ? (
              <>
                <div className="timeline mt-12">
                  {rows.map((memory) => (
                    <PersonTimelineItem key={memory.id} memory={memory} />
                  ))}
                </div>
                {total > 0 ? (
                  <div style={{ borderTop: '1px solid var(--border-faint)', marginTop: 12 }}>
                    <Pagination
                      page={memoriesAsync.data?.page ?? page}
                      totalPages={totalPages}
                      total={total}
                      pageSize={PAGE_SIZE}
                      onChange={setPage}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-12">
                <EmptyState
                  compact
                  icon="brain"
                  title="该人还没有记忆"
                  description="调用方以该人的 external id 写入记忆后，这里会按时间线展示。"
                />
              </div>
            )}
          </Card>

          <MemoryBriefCard
            brief={briefAsync.data}
            loading={briefAsync.loading}
            error={briefAsync.error}
            canManage={false}
            onRefresh={() => void briefAsync.refresh()}
            onOpenSettings={() => undefined}
            title="人的记忆简报"
            desc="只聚合该人 scope=person 记忆 + 与其相关的分区共享记忆，可直接注入提示词。"
            extraBadges={
              <Badge size="sm" tone="cyan">
                人级
              </Badge>
            }
          />

          <DreamStatusCard
            status={dreamAsync.data}
            loading={dreamAsync.loading}
            error={dreamAsync.error}
            memoryCount={stats?.memories ?? 0}
            insightCount={insightAsync.data ?? 0}
            canManage={canManage}
            running={dreaming}
            onRun={() => void runDream()}
            onOpenSettings={() => undefined}
            onOpenRuns={() => setRunsOpen(true)}
            onRetry={() => void dreamAsync.refresh()}
            allowSettings={false}
            extraBadges={
              <Badge size="sm" tone="cyan">
                人级
              </Badge>
            }
          />

          <Card pad>
            <SectionHead
              title="人的上下文"
              desc="人资料 + 人级简报 + 高相关记忆 +（可选）分区共享知识，返回可直接注入提示词的 prompt。"
              actions={
                <div className="hstack gap-8">
                  {contextOpen && contextAsync.data ? (
                    <IconButton
                      icon="refresh"
                      label="重新生成上下文"
                      size="sm"
                      disabled={contextAsync.loading}
                      onClick={() => void contextAsync.refresh()}
                    />
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
              }
            />

            {!contextOpen ? (
              <div className="tiny dim mt-8">
                展开后生成一次上下文预览（POST <span className="mono">/persons/:person/context</span>）。
              </div>
            ) : contextAsync.loading && !contextAsync.data ? (
              <div className="mt-12">
                <LoadingBlock label="正在生成人的上下文…" />
              </div>
            ) : contextAsync.error && !contextAsync.data ? (
              <div className="mt-12 vstack gap-10">
                <ErrorState
                  message={contextAsync.error}
                  onRetry={() => void contextAsync.refresh()}
                />
                {isNotFoundError(contextAsync.error) ? (
                  <Callout tone="amber" icon="info">
                    人的上下文接口尚未就绪（404）；后端上线后点击「重试」即可预览。
                  </Callout>
                ) : null}
              </div>
            ) : contextAsync.data ? (
              <div className="vstack gap-12 mt-12">
                <div className="chip-row">
                  <Badge size="sm" tone="violet" dot>
                    记忆 {fmtInt(contextAsync.data.memories.length)}
                  </Badge>
                  <Badge size="sm" tone="green" dot>
                    共享 {fmtInt(contextAsync.data.shared.length)}
                  </Badge>
                  <Badge size="sm" tone="cyan" dot>
                    简报 {fmtInt(contextAsync.data.brief?.count ?? 0)} 条
                  </Badge>
                  <span className="chip mono">≈ {fmtInt(contextAsync.data.tokenEstimate)} tokens</span>
                  <span className="tiny dim" title={fmtFullDateTime(contextAsync.data.builtAt)}>
                    生成于 {fmtRelative(contextAsync.data.builtAt)}
                  </span>
                </div>
                <CodeBlock
                  code={contextAsync.data.prompt || '（暂无可用内容）'}
                  title="可注入提示词 · prompt"
                  language="markdown"
                />
                {contextAsync.data.citations.length ? (
                  <div className="chip-row">
                    <span className="tiny dim">引用</span>
                    {contextAsync.data.citations.slice(0, 8).map((citation) => (
                      <span key={citation} className="chip mono" title={citation}>
                        {truncateMiddle(citation, 8, 6)}
                      </span>
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

          <DreamRunsModal
            open={runsOpen}
            onClose={() => setRunsOpen(false)}
            runs={dreamAsync.data?.runs ?? []}
            loading={dreamAsync.loading}
            error={dreamAsync.error}
          />
        </>
      ) : null}
    </div>
  );
}

/** 记忆时间线条目：内容 + 分类标签 + scope / 来源 / 会话。 */
function PersonTimelineItem({ memory }: { memory: Memory }) {
  const tone = toneForCategory(memory.category);
  return (
    <div className="tl-item person-tl-item">
      <span className={`tl-dot tone-${tone}`}>
        <Icon name={memory.category === 'insight' ? 'sparkles' : 'brain'} size={12} />
      </span>
      <div className="tl-body">
        <div className="person-tl-head">
          <MemoryContent
            content={memory.content}
            category={memory.category}
            tags={memory.tags}
            clamp={false}
            maxWidth={720}
          />
          <span className="tiny dim nowrap" title={fmtFullDateTime(memory.updatedAt)}>
            {fmtRelative(memory.updatedAt)}
          </span>
        </div>
        <div className="chip-row mt-4">
          <ScopeBadge scope={scopeOf(memory)} size="sm" />
          <Badge tone={memory.source === 'dream' ? 'violet' : 'slate'} size="sm">
            {SOURCE_LABEL[memory.source] ?? memory.source}
          </Badge>
          {memory.sessionId ? (
            <span className="chip mono" title={memory.sessionId}>
              <Icon name="branch" size={11} />
              {truncateMiddle(memory.sessionId, 10, 6)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
