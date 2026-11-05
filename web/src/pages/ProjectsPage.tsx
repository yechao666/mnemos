import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ENVIRONMENTS,
  PROJECT_STATUSES,
  REGIONS,
  type ProjectMember,
  type ProjectStatus,
  type ProjectSummary,
} from '@shared';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Modal,
  PageHead,
  Progress,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Table,
  Textarea,
  useToast,
  type Column,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtCompact, fmtDateTime, fmtInt, fmtPct, fmtRelative } from '@lib/format.ts';
import { toneForStatus } from '@lib/tone.ts';
import {
  projectInitial,
  projectStatusLabel,
  projectTone,
  shortHash,
  slugify,
} from '../components/shell/util.ts';

type ViewMode = 'grid' | 'table';
type SortKey = 'memories' | 'recent';
type StatusFilter = 'all' | ProjectStatus;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...PROJECT_STATUSES.map((status) => ({ value: status.value, label: status.label })),
];

const SORT_OPTIONS = [
  { value: 'memories', label: '按记忆数排序' },
  { value: 'recent', label: '按最近更新排序' },
];

const MEMBER_PREVIEW_LIMIT = 12;

export function ProjectsPage() {
  const navigate = useNavigate();
  const { projects: authProjects } = useAuth();
  const { data, loading, error, refresh } = useAsync(() => api.projects.list(), []);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 200);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('memories');
  const [view, setView] = useState<ViewMode>('grid');
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    const keyword = debouncedQuery.trim().toLowerCase();
    const list = (data ?? []).filter((project) => {
      if (status !== 'all' && project.status !== status) return false;
      if (!keyword) return true;
      return `${project.name} ${project.slug} ${project.description}`.toLowerCase().includes(keyword);
    });
    return [...list].sort((a, b) =>
      sort === 'memories'
        ? (b.stats?.memories ?? 0) - (a.stats?.memories ?? 0)
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [data, status, sort, debouncedQuery]);

  const previewIds = useMemo(
    () => filtered.slice(0, MEMBER_PREVIEW_LIMIT).map((project) => project.id),
    [filtered],
  );
  const membersQuery = useAsync(
    async () => {
      const entries = await Promise.all(
        previewIds.map(async (id) => [id, await api.projects.members.list(id)] as const),
      );
      return Object.fromEntries(entries) as Record<string, ProjectMember[]>;
    },
    [`${view}:${previewIds.join(',')}`],
    view === 'grid' && previewIds.length > 0,
  );
  const membersByProject = membersQuery.data ?? {};

  const resetFilters = () => {
    setQuery('');
    setStatus('all');
    setSort('memories');
  };

  const openCreate = () => setCreateOpen(true);

  const renderMemberStack = (project: ProjectSummary) => {
    const members = membersByProject[project.id];
    if (membersQuery.loading && !members) {
      return <Skeleton w={58} h={20} />;
    }
    if (members && members.length > 0) {
      return (
        <span className="hstack gap-6">
          <span className="hstack gap-4">
            {members.slice(0, 2).map((member) => (
              <Avatar key={member.userId} name={member.name} tone={projectTone(member.userId)} size="sm" />
            ))}
          </span>
          <span className="tiny dim nowrap">共 {members.length} 人</span>
        </span>
      );
    }
    return (
      <span className="tiny dim">
        {project.members > 0 ? `${fmtInt(project.members)} 位成员` : '暂无成员'}
      </span>
    );
  };

  const columns: Column<ProjectSummary>[] = [
    {
      key: 'name',
      header: '项目',
      render: (project) => (
        <div className="hstack gap-10">
          <div
            className={`project-mark tone-${projectTone(project.id)}`}
            style={{ width: 30, height: 30, borderRadius: 9, fontSize: 12 }}
            aria-hidden="true"
          >
            {projectInitial(project.name)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="strong truncate">{project.name}</div>
            <div className="tiny dim truncate">{project.description || '暂无描述'}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'slug',
      header: 'slug',
      render: (project) => <span className="tiny dim mono">{project.slug}</span>,
    },
    {
      key: 'status',
      header: '状态',
      render: (project) => (
        <Badge tone={toneForStatus(project.status)} size="sm" dot>
          {projectStatusLabel(project.status)}
        </Badge>
      ),
    },
    {
      key: 'memories',
      header: '记忆数',
      align: 'right',
      mono: true,
      render: (project) => fmtInt(project.stats?.memories),
    },
    {
      key: 'members',
      header: '成员',
      align: 'right',
      mono: true,
      render: (project) => fmtInt(project.members),
    },
    {
      key: 'searches',
      header: '7 日检索',
      align: 'right',
      mono: true,
      render: (project) => fmtCompact(project.stats?.searches7d),
    },
    {
      key: 'updated',
      header: '更新时间',
      align: 'right',
      render: (project) => (
        <span className="tiny dim" title={fmtDateTime(project.updatedAt)}>
          {fmtRelative(project.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (project) => (
        <Button
          size="sm"
          variant="ghost"
          iconRight="arrowRight"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/projects/${project.id}`);
          }}
        >
          打开
        </Button>
      ),
    },
  ];

  const projectCount = data?.length ?? 0;
  const showEmptyAll = !error && data !== null && projectCount === 0;
  const showEmptyFiltered = projectCount > 0 && filtered.length === 0;

  return (
    <div className="page">
      <PageHead
        eyebrow="项目"
        title="项目"
        desc={`按项目隔离记忆、密钥与用量。当前组织共 ${fmtInt(authProjects.length)} 个项目，进入项目后可管理成员与检索策略。`}
        actions={
          <Button variant="primary" icon="plus" onClick={openCreate}>
            新建项目
          </Button>
        }
      />

      <div className="toolbar">
        <div className="toolbar-left">
          <SearchInput value={query} onChange={setQuery} placeholder="搜索项目名称、slug 或描述…" />
          <Select
            aria-label="状态筛选"
            options={STATUS_OPTIONS}
            value={status}
            style={{ width: 146 }}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          />
          <Select
            aria-label="排序方式"
            options={SORT_OPTIONS}
            value={sort}
            style={{ width: 168 }}
            onChange={(event) => setSort(event.target.value as SortKey)}
          />
        </div>
        <div className="toolbar-right">
          <span className="tiny dim">共 {fmtInt(filtered.length)} 个项目</span>
          <Segmented
            options={[
              { value: 'grid', label: '网格' },
              { value: 'table', label: '表格' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      {error && data ? (
        <Callout tone="amber" icon="alert">刷新失败，当前展示上次加载的项目列表。</Callout>
      ) : null}

      {loading && !data ? (
        <div className="grid grid-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Card key={index} className="project-card">
              <div className="hstack gap-12">
                <Skeleton w={38} h={38} style={{ borderRadius: 11 }} />
                <div className="vstack grow gap-6">
                  <Skeleton w="60%" h={13} />
                  <Skeleton w="40%" h={10} />
                </div>
              </div>
              <Skeleton w="100%" h={32} />
              <Skeleton w="100%" h={56} style={{ borderRadius: 12 }} />
              <Skeleton w="55%" h={22} />
            </Card>
          ))}
        </div>
      ) : error && !data ? (
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      ) : showEmptyAll ? (
        <Card pad>
          <EmptyState
            icon="folder"
            title="还没有项目，先创建第一个"
            description="每个项目拥有独立的记忆空间、API 密钥、成员权限与审计日志，适合按业务线或环境拆分。"
            action={
              <Button variant="primary" icon="plus" onClick={openCreate}>
                新建项目
              </Button>
            }
          />
        </Card>
      ) : showEmptyFiltered ? (
        <Card pad>
          <EmptyState
            icon="search"
            title="没有匹配的项目"
            description="调整搜索关键词或状态筛选后再试，也可以直接创建新项目。"
            action={
              <Button size="sm" icon="refresh" onClick={resetFilters}>
                清除筛选
              </Button>
            }
          />
        </Card>
      ) : view === 'grid' ? (
        <div className="grid grid-3">
          {filtered.map((project) => {
            const quota = project.settings?.monthlyQuota ?? 0;
            const usedPct = project.stats?.quotaUsedPct ?? 0;
            return (
              <Card
                key={project.id}
                hover
                className="project-card"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <div className="project-card-top">
                  <div className={`project-mark tone-${projectTone(project.id)}`} aria-hidden="true">
                    {projectInitial(project.name)}
                  </div>
                  <div className="grow">
                    <div className="between" style={{ gap: 8 }}>
                      <span className="project-name truncate">{project.name}</span>
                      <Badge tone={toneForStatus(project.status)} size="sm" dot>
                        {projectStatusLabel(project.status)}
                      </Badge>
                    </div>
                    <div className="project-slug truncate">{project.slug}</div>
                  </div>
                </div>

                <div className="project-desc clamp-2">{project.description || '暂无项目描述'}</div>

                <div className="project-metrics">
                  <div>
                    <div className="pm-value">{fmtCompact(project.stats?.memories)}</div>
                    <div className="pm-label">记忆</div>
                  </div>
                  <div>
                    <div className="pm-value">{fmtInt(project.members)}</div>
                    <div className="pm-label">成员</div>
                  </div>
                  <div>
                    <div className="pm-value">{fmtCompact(project.stats?.searches7d)}</div>
                    <div className="pm-label">7 日检索</div>
                  </div>
                </div>

                <div className="vstack gap-6">
                  <div className="between tiny dim">
                    <span>月度配额 {quota > 0 ? fmtCompact(quota) : '—'}</span>
                    <span className="mono">{fmtPct(usedPct, 1)}</span>
                  </div>
                  <Progress value={usedPct} thin tone={usedPct > 85 ? 'amber' : 'violet'} />
                </div>

                <div className="between" style={{ marginTop: 'auto', gap: 8 }}>
                  <div className="avatar-stack">{renderMemberStack(project)}</div>
                  <span className="hstack gap-4 tiny nowrap" style={{ color: 'var(--violet)' }}>
                    打开 <Icon name="arrowRight" size={12} />
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={filtered}
            rowKey={(project) => project.id}
            onRowClick={(project) => navigate(`/projects/${project.id}`)}
            empty={
              <EmptyState
                icon="search"
                title="没有匹配的项目"
                description="调整搜索或筛选条件后再试。"
                compact
              />
            }
          />
        </Card>
      )}

      <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh: refreshAuth } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [region, setRegion] = useState(REGIONS[0]?.value ?? 'cn-shanghai');
  const [env, setEnv] = useState(ENVIRONMENTS[0]?.value ?? 'production');
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugTouched(false);
    setDescription('');
    setRegion(REGIONS[0]?.value ?? 'cn-shanghai');
    setEnv(ENVIRONMENTS[0]?.value ?? 'production');
    setFormError(null);
  }, [open]);

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) {
      setSlug(value.trim() ? slugify(value) || `project-${shortHash(value)}` : '');
    }
  };

  const submit = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('请填写项目名称。');
      return;
    }
    const slugValue = (slug.trim() || slugify(trimmed) || `project-${shortHash(trimmed)}`).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slugValue)) {
      setFormError('slug 只能包含小写字母、数字与连字符。');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await api.projects.create({
        name: trimmed,
        slug: slugValue,
        description: description.trim(),
        region,
        env,
      });
      toast.success(`项目「${created.name}」已创建`);
      onClose();
      await refreshAuth();
      navigate(`/projects/${created.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败，请稍后重试。');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目"
      description="项目是记忆隔离与权限授予的最小单元，创建后可在项目设置中调整检索与配额。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" loading={creating} onClick={() => void submit()}>
            创建项目
          </Button>
        </>
      }
    >
      <Field label="项目名称" required htmlFor="project-name">
        <Input
          id="project-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="例如：客服 Copilot"
          autoFocus
        />
      </Field>

      <Field
        label="slug"
        htmlFor="project-slug"
        hint="用于 API 路径与脚本引用，仅支持小写字母、数字与连字符。"
      >
        <Input
          id="project-slug"
          className="mono"
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value);
          }}
          placeholder="customer-copilot"
        />
      </Field>

      <Field label="项目描述" htmlFor="project-description">
        <Textarea
          id="project-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="说明这个项目承载哪类记忆、由哪些应用写入与检索。"
          style={{ minHeight: 78 }}
        />
      </Field>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="区域" htmlFor="project-region">
          <Select
            id="project-region"
            options={REGIONS.map((item) => ({ value: item.value, label: item.label }))}
            value={region}
            onChange={(event) => setRegion(event.target.value)}
          />
        </Field>
        <Field label="环境" htmlFor="project-env">
          <Select
            id="project-env"
            options={ENVIRONMENTS.map((item) => ({ value: item.value, label: item.label }))}
            value={env}
            onChange={(event) => setEnv(event.target.value)}
          />
        </Field>
      </div>

      {formError ? (
        <div className="field-error" role="alert">{formError}</div>
      ) : null}
    </Modal>
  );
}
