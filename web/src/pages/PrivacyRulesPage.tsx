import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  PrivacyRule,
  PrivacyRuleGroup,
  PrivacyRuleScope,
  PrivacyScanResult,
} from '@lib/types.ts';
import {
  PRIVACY_ACTION_LABEL,
  PRIVACY_GROUPS,
  PRIVACY_GROUP_LABEL,
  PRIVACY_MASK_MODE_LABEL,
  PRIVACY_PREVIEW_SAMPLE,
  PRIVACY_RULE_KIND_LABEL,
  PRIVACY_SCOPE_OPTIONS,
  PRIVACY_SEVERITY_LABEL,
  PRIVACY_SEVERITY_TONE,
  PRIVACY_VALIDATOR_LABEL,
  ROLE_RANK,
} from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  PageHead,
  SearchInput,
  SectionHead,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Table,
  Textarea,
  useToast,
  type Column,
} from '@ui';
import { api, isNotFoundError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { PrivacyRuleEditor } from '../components/privacy/PrivacyRuleEditor.tsx';

const SCOPE_SEGMENTS = PRIVACY_SCOPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }));

type GroupStatus = 'on' | 'partial' | 'off';

/** 分组视图：优先用接口统计，接口未上线时按规则列表本地汇总。 */
interface PrivacyGroupView extends PrivacyRuleGroup {
  localFallback: boolean;
}

const GROUP_SORT_ORDER = new Map(PRIVACY_GROUPS.map((group) => [group.key, group.sortOrder]));

function groupLabel(key: string): string {
  return PRIVACY_GROUP_LABEL[key] ?? key ?? '未分组';
}

function groupStatus(group: PrivacyRuleGroup): GroupStatus {
  if (group.ruleCount > 0 && group.enabledCount >= group.ruleCount) return 'on';
  if (group.enabledCount > 0) return 'partial';
  return 'off';
}

function statusBadge(group: PrivacyRuleGroup) {
  const status = groupStatus(group);
  if (status === 'on') return <Badge tone="green" size="sm" dot>已启用</Badge>;
  if (status === 'partial') return <Badge tone="amber" size="sm" dot>部分启用</Badge>;
  return <Badge tone="slate" size="sm" dot>未启用</Badge>;
}

function maskSummary(rule: PrivacyRule): string {
  if (rule.action === 'placeholder') return '→ {{pii_xxxxxxxx}}';
  const label = PRIVACY_MASK_MODE_LABEL[rule.maskMode] ?? rule.maskMode;
  if (rule.maskMode === 'keepFirstLast') return `${label} ${rule.maskKeepFirst}/${rule.maskKeepLast}`;
  if (rule.maskMode === 'keepLast') return `${label} ${rule.maskKeepLast}`;
  return label;
}

/**
 * 本地汇总分组统计（分组接口未上线 / 读取失败时的兜底）：
 *  - ruleCount：全局规则数；
 *  - enabledCount：全局 + 分区同 code 覆盖后的启用条数；
 *  - appliedCount：该分区的覆盖条数。
 */
function localGroupCounts(
  key: string,
  globalRules: PrivacyRule[],
  partitionRules: PrivacyRule[],
  effectiveByCode: Map<string, PrivacyRule>,
): Pick<PrivacyRuleGroup, 'ruleCount' | 'enabledCount' | 'appliedCount'> {
  let enabledCount = 0;
  for (const rule of effectiveByCode.values()) {
    if (rule.groupKey === key && rule.enabled) enabledCount += 1;
  }
  return {
    ruleCount: globalRules.filter((rule) => rule.groupKey === key).length,
    enabledCount,
    appliedCount: partitionRules.filter((rule) => rule.groupKey === key).length,
  };
}

/**
 * 隐私规则页（v6.3）：
 *  - 全局 / 当前分区两套作用域；
 *  - 规则库：18 个行业/领域分组，每组分「启用本组 / 停用本组」写入分区覆盖；
 *  - 规则列表按组筛选 / 搜索 code·name，分组标题展示；
 *  - 保留原文的增删改启停与试跑预览。
 *
 * 分组统计接口（GET /api/privacy/groups）未上线时，页面按规则列表本地汇总，不阻塞其他功能。
 */
export function PrivacyRulesPage() {
  const { partitionId: routePartitionId = '' } = useParams<{ partitionId?: string }>();
  const { partition } = usePartitionContext();
  const { user, partitions } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [scope, setScope] = useState<PrivacyRuleScope>(routePartitionId ? 'partition' : 'global');
  const [selectedPartitionId, setSelectedPartitionId] = useState(
    routePartitionId || partitions[0]?.id || '',
  );

  useEffect(() => {
    if (!routePartitionId) return;
    setScope('partition');
    setSelectedPartitionId(routePartitionId);
  }, [routePartitionId]);

  useEffect(() => {
    if (!selectedPartitionId && partitions[0]) setSelectedPartitionId(partitions[0].id);
  }, [partitions, selectedPartitionId]);

  // 分区路由下 PartitionLayout 已经提供分区详情；组织路由下自行拉取所选分区（用于状态卡与预览）。
  const contextPartition =
    partition && (partition.id === routePartitionId || partition.slug === routePartitionId)
      ? partition
      : null;
  const partitionDetail = useAsync(
    () => api.partitions.get(selectedPartitionId),
    [selectedPartitionId],
    Boolean(!contextPartition && selectedPartitionId),
  );
  // 切换分区时 useAsync 会保留上一页数据，只接受与当前选择匹配的详情。
  const selectedPartition =
    partitionDetail.data &&
    (partitionDetail.data.id === selectedPartitionId || partitionDetail.data.slug === selectedPartitionId)
      ? partitionDetail.data
      : null;
  const activePartition = contextPartition ?? (selectedPartitionId ? selectedPartition : null);
  const effectivePartitionId = activePartition?.id ?? selectedPartitionId;
  const partitionName = activePartition?.name ?? (effectivePartitionId || '未选择分区');

  const userKey = user?.id ?? '';
  const globalQuery = useAsync(() => api.privacy.listRules({ scope: 'global' }), [userKey], Boolean(userKey));
  const partitionQuery = useAsync(
    () => api.privacy.listRules({ scope: 'partition', partitionId: effectivePartitionId }),
    [effectivePartitionId, userKey],
    Boolean(userKey && effectivePartitionId),
  );
  // v6.3 分组统计：需要分区才能算出启用/覆盖；接口未上线时错误进入本地汇总兜底。
  const groupsQuery = useAsync(
    () => api.privacy.groups({ partitionId: effectivePartitionId }),
    [effectivePartitionId, userKey],
    Boolean(userKey && effectivePartitionId),
  );

  const globalRules = globalQuery.data ?? [];
  const partitionRules = partitionQuery.data ?? [];
  const rules = scope === 'global' ? globalRules : partitionRules;
  const loading = scope === 'global' ? globalQuery.loading : partitionQuery.loading;
  const error = scope === 'global' ? globalQuery.error : partitionQuery.error;

  const globalByCode = useMemo(
    () => new Map(globalRules.map((rule) => [rule.code, rule])),
    [globalRules],
  );
  const partitionByCode = useMemo(
    () => new Map(partitionRules.map((rule) => [rule.code, rule])),
    [partitionRules],
  );
  const effectiveByCode = useMemo(() => {
    const map = new Map(globalByCode);
    for (const [code, rule] of partitionByCode) map.set(code, rule);
    return map;
  }, [globalByCode, partitionByCode]);

  const role = user?.role;
  const canWrite = scope === 'global' ? role === 'owner' : Boolean(role && ROLE_RANK[role] >= ROLE_RANK.admin);
  const canApplyGroups = Boolean(effectivePartitionId) && Boolean(role && ROLE_RANK[role] >= ROLE_RANK.admin);
  const settings = activePartition?.settings;
  const piiRedaction = settings?.piiRedaction === 'basic' ? 'basic' : 'off';
  const llmEnabled = settings?.privacyLlmEnabled === true;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<PrivacyRule | null>(null);
  const [toggleBusyId, setToggleBusyId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PrivacyRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [groupFilter, setGroupFilter] = useState('');
  const [search, setSearch] = useState('');
  const [groupBusy, setGroupBusy] = useState('');

  const refreshRules = async () => {
    await Promise.all([
      globalQuery.refresh(),
      effectivePartitionId ? partitionQuery.refresh() : Promise.resolve(null),
      effectivePartitionId ? groupsQuery.refresh() : Promise.resolve(null),
    ]);
  };

  /* ------------------------------ 规则库分组 ------------------------------ */

  const groupViews = useMemo<PrivacyGroupView[]>(() => {
    const apiByKey = new Map((groupsQuery.data ?? []).map((group) => [group.key, group]));
    const keys = new Set<string>([
      ...PRIVACY_GROUPS.map((group) => group.key),
      ...apiByKey.keys(),
      ...globalRules.map((rule) => rule.groupKey),
      ...partitionRules.map((rule) => rule.groupKey),
    ]);
    return [...keys]
      .filter(Boolean)
      .map((key) => {
        const apiGroup = apiByKey.get(key);
        const meta = PRIVACY_GROUPS.find((group) => group.key === key);
        const local = localGroupCounts(key, globalRules, partitionRules, effectiveByCode);
        return {
          key,
          name: apiGroup?.name || meta?.name || key,
          industry: apiGroup?.industry ?? meta?.industry ?? '',
          description: apiGroup?.description ?? meta?.description ?? '',
          sortOrder: apiGroup?.sortOrder ?? meta?.sortOrder ?? GROUP_SORT_ORDER.get(key) ?? 999,
          builtin: apiGroup?.builtin ?? true,
          ruleCount: apiGroup ? apiGroup.ruleCount : local.ruleCount,
          enabledCount: apiGroup ? apiGroup.enabledCount : local.enabledCount,
          appliedCount: apiGroup ? apiGroup.appliedCount : local.appliedCount,
          localFallback: !apiGroup,
        } satisfies PrivacyGroupView;
      })
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'));
  }, [groupsQuery.data, globalRules, partitionRules, effectiveByCode]);

  const groupsEndpointDown = Boolean(groupsQuery.error);

  const groupFilterOptions = useMemo(
    () => [
      { value: '', label: `全部分组（${groupViews.length}）` },
      ...groupViews.map((group) => ({
        value: group.key,
        label: `${group.name} · ${group.enabledCount}/${group.ruleCount}`,
      })),
    ],
    [groupViews],
  );

  /* ------------------------------ 规则筛选 ------------------------------ */

  const normalizedSearch = search.trim().toLowerCase();
  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      if (groupFilter && rule.groupKey !== groupFilter) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        rule.code,
        rule.name,
        rule.entityType,
        groupLabel(rule.groupKey),
        rule.validator,
        rule.region,
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [rules, groupFilter, normalizedSearch]);

  // 分组标题展示：按 18 组顺序分成区块，只渲染有命中规则的组。
  const listSections = useMemo(() => {
    return groupViews
      .map((group) => ({
        group,
        groupRules: filteredRules.filter((rule) => rule.groupKey === group.key),
      }))
      .filter((section) => section.groupRules.length > 0);
  }, [groupViews, filteredRules]);

  const activeGroupMeta = groupFilter
    ? groupViews.find((group) => group.key === groupFilter) ??
      PRIVACY_GROUPS.find((group) => group.key === groupFilter) ??
      null
    : null;

  /* ------------------------------ 规则操作 ------------------------------ */

  const openCreate = () => {
    if (!canWrite) {
      toast.warning(scope === 'global' ? '全局规则需要 owner 权限' : '分区规则需要管理员及以上权限');
      return;
    }
    if (scope === 'partition' && !effectivePartitionId) {
      toast.warning('请先选择分区');
      return;
    }
    setEditingRule(null);
    setEditorOpen(true);
  };

  const openEdit = (rule: PrivacyRule) => {
    setEditingRule(rule);
    setEditorOpen(true);
  };

  const toggleRule = async (rule: PrivacyRule) => {
    if (!canWrite || toggleBusyId) return;
    setToggleBusyId(rule.id);
    try {
      await api.privacy.updateRule(rule.id, { enabled: !rule.enabled });
      toast.success(`规则「${rule.name}」已${rule.enabled ? '停用' : '启用'}`);
      await refreshRules();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '启停失败');
    } finally {
      setToggleBusyId('');
    }
  };

  const removeRule = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.privacy.removeRule(deleteTarget.id);
      toast.success(`规则「${deleteTarget.name}」已删除`);
      setDeleteTarget(null);
      await refreshRules();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const applyGroup = async (group: PrivacyRuleGroup, enabled: boolean) => {
    if (groupBusy) return;
    if (!effectivePartitionId) {
      toast.warning('整组启停需要先选择分区（写入分区覆盖规则）');
      return;
    }
    if (!canApplyGroups) {
      toast.warning('整组启停需要分区管理员及以上权限');
      return;
    }
    const busyKey = `${group.key}:${enabled ? 'on' : 'off'}`;
    setGroupBusy(busyKey);
    try {
      await api.privacy.applyGroup(group.key, { partitionId: effectivePartitionId, enabled });
      toast.success(
        enabled
          ? `已启用「${group.name}」全部规则（写入 ${partitionName} 的分区覆盖）`
          : `已停用「${group.name}」全部规则（写入 ${partitionName} 的分区覆盖）`,
      );
      await refreshRules();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '整组启停失败';
      toast.error(message);
      if (isNotFoundError(message)) {
        toast.warning('整组启停接口可能尚未上线（POST /api/privacy/groups/:key/apply）');
      }
    } finally {
      setGroupBusy('');
    }
  };

  const columns: Column<PrivacyRule>[] = [
    {
      key: 'rule',
      header: '规则',
      render: (rule) => (
        <div style={{ minWidth: 0 }}>
          <div className="hstack gap-6 wrap">
            <span className="mono small">{rule.code}</span>
            {rule.builtin ? <Badge tone="amber" size="sm">内置</Badge> : null}
            {scope === 'partition' && globalByCode.has(rule.code) ? (
              <Badge tone="cyan" size="sm" dot>覆盖全局</Badge>
            ) : null}
            {scope === 'global' && partitionByCode.has(rule.code) ? (
              <Badge tone="cyan" size="sm" dot>已被分区覆盖</Badge>
            ) : null}
          </div>
          <div className="strong truncate">{rule.name}</div>
          <div className="tiny dim mono">{rule.entityType}</div>
        </div>
      ),
    },
    {
      key: 'kind',
      header: '类型',
      width: 116,
      render: (rule) => (
        <Badge tone={rule.kind === 'prompt' ? 'pink' : 'violet'} size="sm">
          {PRIVACY_RULE_KIND_LABEL[rule.kind] ?? rule.kind}
        </Badge>
      ),
    },
    {
      key: 'guards',
      header: '校验 / 上下文',
      width: 210,
      render: (rule) => (
        <div className="vstack gap-4">
          <div className="hstack gap-4 wrap">
            <Badge tone={PRIVACY_SEVERITY_TONE[rule.severity] ?? 'slate'} size="sm">
              {PRIVACY_SEVERITY_LABEL[rule.severity] ?? rule.severity}
            </Badge>
            {rule.kind === 'regex' && rule.validator && rule.validator !== 'none' ? (
              <Badge tone="green" size="sm" dot>
                {PRIVACY_VALIDATOR_LABEL[rule.validator] ?? rule.validator}
              </Badge>
            ) : null}
            {rule.kind === 'regex' && rule.contextKeywords.length > 0 ? (
              <Badge tone="amber" size="sm">上下文 ×{rule.contextKeywords.length}</Badge>
            ) : null}
            {rule.kind === 'regex' && !rule.caseSensitive ? (
              <Badge tone="cyan" size="sm">忽略大小写</Badge>
            ) : null}
          </div>
          <span className="tiny dim">
            {rule.kind === 'regex'
              ? `${rule.validator && rule.validator !== 'none' ? '有校验器' : '无校验器'} · ${
                  rule.contextKeywords.length ? `上下文 ${rule.contextKeywords.length} 个` : '无上下文'
                }`
              : 'LLM 抽取 · 无结构校验'}
            {rule.region ? ` · ${rule.region}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'action',
      header: '动作 / 打码',
      width: 168,
      render: (rule) => (
        <div className="vstack gap-2 privacy-rule-action">
          <Badge tone={rule.action === 'placeholder' ? 'cyan' : 'green'} size="sm">
            {PRIVACY_ACTION_LABEL[rule.action] ?? rule.action}
          </Badge>
          <span className="tiny dim mono">{maskSummary(rule)}</span>
        </div>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      width: 72,
      align: 'center',
      render: (rule) => <span className="mono">{rule.priority}</span>,
    },
    {
      key: 'enabled',
      header: '启用',
      width: 72,
      align: 'center',
      render: (rule) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={rule.enabled}
            disabled={!canWrite}
            onChange={() => void toggleRule(rule)}
          />
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 88,
      align: 'right',
      render: (rule) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
          <IconButton
            icon="pencil"
            label={canWrite ? '编辑规则' : '需要更高权限'}
            size="sm"
            disabled={!canWrite}
            onClick={() => openEdit(rule)}
          />
          <IconButton
            icon="trash"
            label={rule.builtin ? '内置规则不可删除，可停用' : canWrite ? '删除规则' : '需要更高权限'}
            size="sm"
            disabled={!canWrite || rule.builtin || toggleBusyId === rule.id}
            onClick={() => setDeleteTarget(rule)}
          />
        </div>
      ),
    },
  ];

  /* ------------------------------ 分组卡片 ------------------------------ */

  const groupCards = (
    <div className="privacy-group-grid">
      {groupViews.map((group) => {
        const status = groupStatus(group);
        const active = groupFilter === group.key;
        const disableNoop = status === 'off' && group.appliedCount === 0;
        const busyOn = groupBusy === `${group.key}:on`;
        const busyOff = groupBusy === `${group.key}:off`;
        return (
          <Card
            key={group.key}
            pad
            hover
            className={`privacy-group-card${active ? ' is-active' : ''}`}
            onClick={() => setGroupFilter(active ? '' : group.key)}
          >
            <div className="between wrap gap-8">
              <div className="hstack gap-6 wrap" style={{ minWidth: 0 }}>
                <span className="strong truncate">{group.name}</span>
                {group.industry ? <Badge tone="slate" size="sm">{group.industry}</Badge> : null}
              </div>
              {statusBadge(group)}
            </div>

            <div className="tiny dim mt-4 privacy-group-desc" title={group.description}>
              {group.description || '—'}
            </div>

            <div className="privacy-group-counts mt-8">
              <div>
                <span className="mono strong">{group.ruleCount}</span>
                <span className="tiny dim"> 条规则</span>
              </div>
              <div>
                <span className="mono strong">{group.enabledCount}</span>
                <span className="tiny dim"> 已启用</span>
              </div>
              <div>
                <span className="mono strong">{group.appliedCount}</span>
                <span className="tiny dim"> 分区覆盖</span>
              </div>
            </div>

            <div
              className="hstack gap-6 wrap mt-8"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                size="sm"
                variant={status === 'on' ? 'ghost' : 'primary'}
                disabled={!canApplyGroups || Boolean(groupBusy) || status === 'on'}
                loading={busyOn}
                title={
                  !effectivePartitionId
                    ? '请先选择分区：整组启停写入分区覆盖'
                    : !canApplyGroups
                      ? '需要分区管理员及以上权限'
                      : status === 'on'
                        ? '该组规则已全部启用'
                        : '为当前分区启用该组全部规则'
                }
                onClick={() => void applyGroup(group, true)}
              >
                启用本组
              </Button>
              <Button
                size="sm"
                disabled={!canApplyGroups || Boolean(groupBusy) || disableNoop}
                loading={busyOff}
                title={
                  !effectivePartitionId
                    ? '请先选择分区'
                    : !canApplyGroups
                      ? '需要分区管理员及以上权限'
                      : disableNoop
                        ? '该组没有启用的规则'
                        : '为当前分区停用该组全部规则'
                }
                onClick={() => void applyGroup(group, false)}
              >
                停用本组
              </Button>
              {active ? (
                <Button size="sm" variant="ghost" onClick={() => setGroupFilter('')}>
                  清除筛选
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setGroupFilter(group.key)}>
                  看规则
                </Button>
              )}
            </div>

            <div className="tiny dim mt-6">
              {group.localFallback ? '本地汇总（分组统计接口未上线）' : `覆盖 ${group.appliedCount} 条`}
            </div>
          </Card>
        );
      })}
    </div>
  );

  /* ------------------------------ 规则列表 ------------------------------ */

  const listCard = (
    <Card>
      <div style={{ padding: '14px 16px 0' }}>
        <SectionHead
          title={
            groupFilter
              ? `规则 · ${activeGroupMeta?.name ?? groupLabel(groupFilter)}`
              : scope === 'global'
                ? '全部全局规则'
                : `全部规则 · ${partitionName}`
          }
          desc={
            groupFilter
              ? activeGroupMeta?.description || '按分组筛选规则；清除筛选可查看全部规则。'
              : scope === 'global'
                ? '组织默认规则；分区可用同 code 的规则覆盖（含停用）。全局写权限仅 owner。'
                : '只影响当前分区；同 code 时覆盖全局规则的 pattern / instruction / action / enabled。'
          }
          actions={
            <div className="hstack gap-8">
              <Badge tone="slate" size="sm">{filteredRules.length} 条</Badge>
              <IconButton
                icon="refresh"
                label="刷新规则"
                size="sm"
                disabled={loading}
                onClick={() => void refreshRules()}
              />
              <Button size="sm" variant="primary" icon="plus" disabled={!canWrite} onClick={openCreate}>
                新建规则
              </Button>
            </div>
          }
        />

        <div className="privacy-list-filters">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="搜索 code / name / entityType…"
          />
          <div className="hstack gap-8 wrap">
            <span className="tiny dim nowrap">分组</span>
            <Select
              aria-label="按规则库分组筛选"
              style={{ width: 190 }}
              options={groupFilterOptions}
              value={groupFilter}
              onChange={(event) => setGroupFilter(event.target.value)}
            />
          </div>
          {search || groupFilter ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setGroupFilter('');
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      </div>

      {error && rules.length > 0 ? (
        <div style={{ padding: '10px 16px 0' }}>
          <Callout tone="amber" icon="alert">刷新规则失败，已保留上次结果：{error}</Callout>
        </div>
      ) : null}

      {error && rules.length === 0 ? (
        <div className="vstack gap-10" style={{ padding: 16 }}>
          <ErrorState message={error} onRetry={() => void refreshRules()} />
          <Callout tone="amber" icon="info">
            隐私规则接口可能尚未上线（<span className="mono">GET /api/privacy/rules</span>
            ）。后端就绪后点击「重试」即可；页面其他部分不受影响。
          </Callout>
        </div>
      ) : loading && rules.length === 0 ? (
        <div className="vstack gap-8" style={{ padding: 16 }}>
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={48} style={{ borderRadius: 8 }} />)}
        </div>
      ) : listSections.length === 0 ? (
        <div style={{ padding: 16 }}>
          <EmptyState
            icon="shield"
            title={search || groupFilter ? '没有匹配的规则' : scope === 'global' ? '还没有全局隐私规则' : '这个分区还没有自定义规则'}
            description={
              search || groupFilter
                ? '试试清除搜索或分组筛选；也可以新建一条规则。'
                : scope === 'global'
                  ? '全局内置规则由服务端初始化（18 组 / 85 条，默认仅启用 email / phone / id_card / bank_card）。'
                  : '分区未覆盖任何规则时，会直接使用全局规则。新建同 code 的规则即可覆盖全局。'
            }
            action={
              canWrite ? (
                <Button size="sm" icon="plus" onClick={openCreate}>新建规则</Button>
              ) : (
                <span className="tiny dim">当前账号只读；需要{scope === 'global' ? ' owner ' : '管理员及以上 '}权限。</span>
              )
            }
          />
        </div>
      ) : (
        <div className="privacy-rule-sections">
          {listSections.map((section, index) => {
            const sectionStatus = statusBadge(section.group);
            return (
              <div className="privacy-rule-section" key={section.group.key}>
                {(groupFilter ? listSections.length > 1 : true) ? (
                  <div className="privacy-rule-section-head">
                    <div className="hstack gap-8 wrap" style={{ minWidth: 0 }}>
                      <span className="section-title truncate">{section.group.name}</span>
                      {section.group.industry ? (
                        <Badge tone="slate" size="sm">{section.group.industry}</Badge>
                      ) : null}
                      <span className="tiny dim">{section.groupRules.length} 条</span>
                      {sectionStatus}
                      {section.group.appliedCount ? (
                        <Badge tone="cyan" size="sm" dot>覆盖 {section.group.appliedCount}</Badge>
                      ) : null}
                    </div>
                    <div className="hstack gap-6" onClick={(event) => event.stopPropagation()}>
                      {groupFilter === section.group.key ? (
                        <Button size="sm" variant="ghost" onClick={() => setGroupFilter('')}>
                          查看全部
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setGroupFilter(section.group.key)}>
                          只看本组
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={
                          !canApplyGroups ||
                          Boolean(groupBusy) ||
                          groupStatus(section.group) === 'on'
                        }
                        loading={groupBusy === `${section.group.key}:on`}
                        onClick={() => void applyGroup(section.group, true)}
                      >
                        启用本组
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          !canApplyGroups ||
                          Boolean(groupBusy) ||
                          (groupStatus(section.group) === 'off' && section.group.appliedCount === 0)
                        }
                        loading={groupBusy === `${section.group.key}:off`}
                        onClick={() => void applyGroup(section.group, false)}
                      >
                        停用本组
                      </Button>
                    </div>
                  </div>
                ) : null}
                <Table
                  columns={index === 0 || groupFilter ? columns : columns.map((column) => ({ ...column, header: '' }))}
                  rows={section.groupRules}
                  rowKey={(rule) => rule.id}
                  loading={false}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="隐私规则"
        title="隐私规则管理"
        desc="规则库按 18 个行业/领域分组（共 85 条内置规则）：默认只启用 4 条高置信度通用规则，其余按组一键启用；支持正则、LLM 提示词、校验器与上下文关键词。"
        actions={
          <>
            <Button
              icon="settings"
              disabled={!effectivePartitionId}
              onClick={() => navigate(`/partitions/${effectivePartitionId}/settings#compliance`)}
            >
              分区合规设置
            </Button>
            <Button icon="refresh" loading={loading} onClick={() => void refreshRules()}>
              刷新
            </Button>
          </>
        }
      />

      <div className="toolbar privacy-toolbar">
        <div className="toolbar-left">
          <div className="hstack gap-8 wrap">
            <span className="tiny dim nowrap">作用域</span>
            <Segmented
              options={SCOPE_SEGMENTS}
              value={scope}
              onChange={(next) => setScope(next as PrivacyRuleScope)}
            />
          </div>
          {scope === 'partition' && !routePartitionId ? (
            <div className="hstack gap-8 wrap">
              <span className="tiny dim nowrap">分区</span>
              <Select
                aria-label="选择分区"
                style={{ width: 200 }}
                options={partitions.map((item) => ({ value: item.id, label: item.name }))}
                value={selectedPartitionId}
                onChange={(event) => setSelectedPartitionId(event.target.value)}
              />
            </div>
          ) : null}
          <span className="tiny dim">
            {scope === 'global'
              ? '全局规则对所有分区生效，除非被同 code 的分区规则覆盖。'
              : `当前分区：${partitionName}`}
          </span>
        </div>
      </div>

      <Card pad>
        <div className="between wrap gap-10">
          <div>
            <div className="section-title">规则如何生效</div>
            <div className="tiny dim mt-4">
              生效规则 = 全局 + 当前分区；同 <span className="mono">code</span> 时分区覆盖全局，按
              <span className="mono"> priority </span>升序执行（小者先）。正则命中后再过
              <span className="mono"> validator </span>（结构/校验位）与
              <span className="mono"> contextKeywords </span>（命中值附近需出现关键词）；prompt 规则需 LLM
              且分区开启 <span className="mono"> privacyLlmEnabled</span>，不可用时静默回退正则。
            </div>
          </div>
          <div className="hstack gap-6 wrap">
            <Badge tone={piiRedaction === 'basic' ? 'green' : 'slate'} size="sm" dot>
              PII 总开关 {piiRedaction}
            </Badge>
            <Badge tone={llmEnabled ? 'green' : 'slate'} size="sm" dot>
              提示词规则 {llmEnabled ? '已开启' : '未开启'}
            </Badge>
            <Badge tone="violet" size="sm">schema v9 · 18 组</Badge>
          </div>
        </div>

        {!activePartition && selectedPartitionId && partitionDetail.loading ? (
          <div className="tiny dim mt-10">正在读取分区设置（piiRedaction / privacyLlmEnabled）…</div>
        ) : !activePartition && !effectivePartitionId ? (
          <div className="mt-10">
            <Callout tone="amber" icon="alert">
              尚未选择分区，无法整组启停或试跑预览。整组启停会为分区写入覆盖规则；请先从分区列表进入某个分区，或在组织级隐私规则页选择分区。
            </Callout>
          </div>
        ) : piiRedaction === 'off' ? (
          <div className="mt-10">
            <Callout tone="amber" icon="alert">
              当前分区 PII 总开关为 <span className="mono">off</span>：规则不会在写入时执行。
              如需写入脱敏，请到分区设置把 <span className="mono">piiRedaction</span> 切到 basic；
              调用方显式提交 <span className="mono">placeholders</span> 映射时仍会保存。
            </Callout>
          </div>
        ) : !llmEnabled ? (
          <div className="mt-10">
            <Callout tone="slate" icon="info">
              提示词规则未开启：当前只执行正则规则。需要 LLM 抽取（人名 / 地址 / 凭据等）时，
              在分区设置开启 <span className="mono">privacyLlmEnabled</span> 并确保服务端已配置 LLM。
            </Callout>
          </div>
        ) : null}
      </Card>

      <Card>
        <div style={{ padding: '14px 16px 0' }}>
          <SectionHead
            title={`规则库（${groupViews.length} 组）`}
            desc={
              effectivePartitionId
                ? `按行业/领域分组；「启用本组 / 停用本组」会为「${partitionName}」写入覆盖规则（同 code 覆盖全局）。`
                : '按行业/领域分组；整组启停需要先选择分区（写入分区覆盖规则）。'
            }
            actions={
              <div className="hstack gap-8">
                <Badge tone="violet" size="sm">{globalRules.length} 条内置</Badge>
                {groupsQuery.loading ? <Badge tone="slate" size="sm">统计读取中…</Badge> : null}
                <IconButton
                  icon="refresh"
                  label="刷新分组统计"
                  size="sm"
                  disabled={!effectivePartitionId || groupsQuery.loading}
                  onClick={() => void groupsQuery.refresh()}
                />
              </div>
            }
          />
        </div>

        <div style={{ padding: '12px 16px 16px' }}>
          {groupsEndpointDown ? (
            <div className="mt-2 mb-10">
              <Callout tone="amber" icon="info">
                分组统计接口暂不可用（<span className="mono">GET /api/privacy/groups</span>
                ），当前按规则列表本地汇总启用 / 覆盖数；整组启停仍需后端
                <span className="mono"> POST /api/privacy/groups/:key/apply </span> 上线。
                {groupsQuery.error ? <span className="tiny dim">（{groupsQuery.error}）</span> : null}
              </Callout>
            </div>
          ) : null}
          {groupCards}
          {!canApplyGroups ? (
            <div className="tiny dim mt-10">
              整组启停需要分区管理员及以上权限；当前账号可按组筛选规则，但启用/停用按钮不可用。
            </div>
          ) : null}
        </div>
      </Card>

      {listCard}

      <PrivacyPreviewCard
        partitionId={effectivePartitionId}
        partitionName={partitionName}
        disabled={!effectivePartitionId}
      />

      <Callout tone="slate" icon="info">
        规则变更可触发 <span className="mono">POST /api/partitions/:partition/privacy/rescan</span> 重扫历史记忆；
        内置规则库由服务端按 v9 schema 初始化（18 组 / 85 条，仅 email / phone / id_card / bank_card 默认启用）。
      </Callout>

      <PrivacyRuleEditor
        open={editorOpen}
        scope={scope}
        partitionId={effectivePartitionId}
        rule={editingRule}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          void refreshRules();
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void removeRule()}
        title="删除隐私规则"
        description={
          deleteTarget
            ? `将删除规则「${deleteTarget.name}」（${deleteTarget.code}）。删除后该分区 / 全局将回退到上层规则。`
            : undefined
        }
        confirmLabel="删除"
        loading={deleting}
      />
    </div>
  );
}

/** 预览卡：POST /api/privacy/preview，展示命中、替换后文本与占位符映射（不落库）。 */
function PrivacyPreviewCard({
  partitionId,
  partitionName,
  disabled,
}: {
  partitionId: string;
  partitionName: string;
  disabled: boolean;
}) {
  const [text, setText] = useState(PRIVACY_PREVIEW_SAMPLE);
  const [result, setResult] = useState<PrivacyScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (disabled || loading) return;
    if (!text.trim()) {
      setError('请输入要试跑的文本。');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setResult(await api.privacy.preview({ partitionId, text }));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : '预览失败');
    } finally {
      setLoading(false);
    }
  };

  const placeholderEntries = result ? Object.entries(result.placeholders) : [];

  return (
    <Card pad>
      <SectionHead
        title="试跑预览"
        desc={`按全局 + 「${partitionName}」分区合并后的规则试跑，不写入数据库；prompt 规则在 LLM 可用且已开启时参与。`}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon="play"
            loading={loading}
            disabled={disabled || !text.trim()}
            onClick={() => void run()}
          >
            运行预览
          </Button>
        }
      />

      <div className="mt-12">
        <Field
          label="待扫描文本"
          htmlFor="privacy-preview-text"
          hint="示例包含手机号 / 邮箱 / 身份证 / 银行卡；也可以粘贴一段真实业务文本试跑。"
        >
          <Textarea
            id="privacy-preview-text"
            value={text}
            maxLength={20_000}
            style={{ minHeight: 92 }}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      </div>

      {disabled ? (
        <div className="mt-10">
          <Callout tone="amber" icon="alert">需要先选择分区才能试跑（规则按分区合并）。</Callout>
        </div>
      ) : null}

      {error ? (
        <div className="mt-10">
          <Callout tone="red" icon="alert">
            {error}
            {isNotFoundError(error) ? (
              <div className="mt-4 tiny dim">
                预览接口可能尚未上线（<span className="mono">POST /api/privacy/preview</span>）；规则列表与其他功能不受影响。
              </div>
            ) : null}
          </Callout>
        </div>
      ) : null}

      {loading && !result ? (
        <div className="vstack gap-8 mt-12">
          {[0, 1, 2].map((index) => <Skeleton key={index} h={44} style={{ borderRadius: 8 }} />)}
        </div>
      ) : result ? (
        <div className="vstack gap-12 mt-12">
          <div className="chip-row">
            <Badge tone={result.hits.length ? 'amber' : 'green'} size="sm" dot>
              {result.hits.length ? `命中 ${result.hits.length} 处` : '未命中任何规则'}
            </Badge>
            <Badge tone={result.redacted ? 'green' : 'slate'} size="sm">
              {result.redacted ? '已按规则替换' : '原文未变化'}
            </Badge>
            {placeholderEntries.length ? (
              <Badge tone="cyan" size="sm">生成 {placeholderEntries.length} 个占位符</Badge>
            ) : null}
          </div>

          <div>
            <div className="small">替换后文本</div>
            <pre className="privacy-preview-text mt-6">{result.text || '（服务端未返回替换后文本）'}</pre>
          </div>

          {result.hits.length ? (
            <div>
              <div className="small">命中明细</div>
              <div className="privacy-hit-list mt-6">
                <div className="privacy-hit-row is-head">
                  <span>动作</span>
                  <span>规则</span>
                  <span>实体</span>
                  <span>命中值</span>
                  <span>位置</span>
                </div>
                {result.hits.map((hit, index) => (
                  <div className="privacy-hit-row" key={`${hit.code}-${hit.start}-${index}`}>
                    <Badge tone={hit.action === 'placeholder' ? 'cyan' : 'green'} size="sm">
                      {PRIVACY_ACTION_LABEL[hit.action] ?? hit.action}
                    </Badge>
                    <span className="mono tiny">{hit.code}</span>
                    <span className="tiny dim">{hit.entityType}</span>
                    <span className="mono tiny privacy-hit-value">{hit.value}</span>
                    <span className="tiny dim mono">{hit.start}–{hit.end}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="tiny dim">
              没有命中：检查规则是否启用、总开关是否为 basic、prompt 规则是否已开启；也可以换一段文本再试。
            </div>
          )}

          {placeholderEntries.length ? (
            <div>
              <div className="small">占位符映射</div>
              <div className="privacy-placeholder-map mt-6">
                {placeholderEntries.map(([token, value]) => (
                  <div className="placeholder-item" key={token}>
                    <span className="placeholder-token mono">{`{{${token}}}`}</span>
                    <span className="placeholder-value mono">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
