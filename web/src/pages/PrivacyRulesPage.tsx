import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  PrivacyRule,
  PrivacyRuleGroup,
  PrivacyRuleInput,
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
  type Tone,
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

const GROUP_STATUS_LABEL: Record<GroupStatus, string> = {
  on: '已启用',
  partial: '部分启用',
  off: '未启用',
};

const GROUP_STATUS_TONE: Record<GroupStatus, Tone> = {
  on: 'green',
  partial: 'amber',
  off: 'slate',
};

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
  return (
    <Badge tone={GROUP_STATUS_TONE[status]} size="sm" dot>
      {GROUP_STATUS_LABEL[status]}
    </Badge>
  );
}

function maskSummary(rule: PrivacyRule): string {
  if (rule.action === 'placeholder') return '→ {{pii_xxxxxxxx}}';
  const label = PRIVACY_MASK_MODE_LABEL[rule.maskMode] ?? rule.maskMode;
  if (rule.maskMode === 'keepFirstLast') return `${label} ${rule.maskKeepFirst}/${rule.maskKeepLast}`;
  if (rule.maskMode === 'keepLast') return `${label} ${rule.maskKeepLast}`;
  return label;
}

/**
 * 分组统计（与右侧表格同源，保证「计数 = 实际展示的生效规则」）：
 *  - ruleCount：全局 + 分区同 code 覆盖后的生效条数；
 *  - enabledCount：其中启用条数；
 *  - appliedCount：该分区的覆盖条数（含分区自定义）。
 *
 * 说明：分区覆盖可以改 groupKey，因此不能只用接口返回的统计（按全局组归属计算），
 * 这里按生效规则实时汇总；分组名称/行业/描述仍用接口 / 常量兜底。
 */
function localGroupCounts(
  key: string,
  partitionRules: PrivacyRule[],
  effectiveByCode: Map<string, PrivacyRule>,
): Pick<PrivacyRuleGroup, 'ruleCount' | 'enabledCount' | 'appliedCount'> {
  let ruleCount = 0;
  let enabledCount = 0;
  for (const rule of effectiveByCode.values()) {
    if (rule.groupKey !== key) continue;
    ruleCount += 1;
    if (rule.enabled) enabledCount += 1;
  }
  return {
    ruleCount,
    enabledCount,
    appliedCount: partitionRules.filter((rule) => rule.groupKey === key).length,
  };
}

/** 全局规则 → 分区覆盖输入（POST /api/privacy/rules，同 code 覆盖全局）。 */
function overrideInputFrom(rule: PrivacyRule, enabled: boolean): PrivacyRuleInput {
  return {
    code: rule.code,
    name: rule.name,
    kind: rule.kind,
    pattern: rule.pattern,
    flags: rule.flags,
    instruction: rule.instruction,
    entityType: rule.entityType,
    action: rule.action,
    maskMode: rule.maskMode,
    maskKeepLast: rule.maskKeepLast,
    maskKeepFirst: rule.maskKeepFirst,
    priority: rule.priority,
    enabled,
    groupKey: rule.groupKey,
    validator: rule.validator,
    contextKeywords: rule.contextKeywords,
    caseSensitive: rule.caseSensitive,
    region: rule.region,
    severity: rule.severity,
  };
}

/**
 * 隐私规则页（v6.5 重构）：
 *  - 左侧粘性「行业 / 领域」导航（可搜索）：「全部规则」+ 18 组，显示组名/行业/规则数/启停状态；
 *  - 右侧主区：选中组头部（描述 / 计数 / 启用本组 / 停用本组）+ 规则表格；搜索为全局搜索；
 *  - 作用域 partition 展示「全局 + 分区覆盖」合并后的生效规则，行上标记来源：
 *    分区覆盖行可编辑/删除/启停；仅全局行只读，提供「覆盖」与启停创建覆盖；
 *  - 保留试跑预览、规则编辑器、新增规则；组筛选下拉由左栏替代。
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
  const loading = globalQuery.loading || (scope === 'partition' && partitionQuery.loading);
  const error = scope === 'global' ? globalQuery.error : partitionQuery.error ?? globalQuery.error;

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
  const [seedRule, setSeedRule] = useState<PrivacyRule | null>(null);
  const [toggleBusyId, setToggleBusyId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PrivacyRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [search, setSearch] = useState('');
  const [navSearch, setNavSearch] = useState('');
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
        const local = localGroupCounts(key, partitionRules, effectiveByCode);
        return {
          key,
          name: apiGroup?.name || meta?.name || key,
          industry: apiGroup?.industry ?? meta?.industry ?? '',
          description: apiGroup?.description ?? meta?.description ?? '',
          sortOrder: apiGroup?.sortOrder ?? meta?.sortOrder ?? GROUP_SORT_ORDER.get(key) ?? 999,
          builtin: apiGroup?.builtin ?? true,
          ruleCount: local.ruleCount,
          enabledCount: local.enabledCount,
          appliedCount: local.appliedCount,
          localFallback: !apiGroup,
        } satisfies PrivacyGroupView;
      })
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'));
  }, [groupsQuery.data, globalRules, partitionRules, effectiveByCode]);

  const groupsEndpointDown = Boolean(groupsQuery.error);

  /** 全局作用域按全局规则重算启用数（接口统计是按分区算的，避免误导）。 */
  const navGroups = useMemo<PrivacyGroupView[]>(() => {
    if (scope === 'partition') return groupViews;
    return groupViews.map((group) => {
      const globalGroupRules = globalRules.filter((rule) => rule.groupKey === group.key);
      return {
        ...group,
        ruleCount: globalGroupRules.length,
        enabledCount: globalGroupRules.filter((rule) => rule.enabled).length,
        appliedCount: partitionRules.filter((rule) => rule.groupKey === group.key).length,
      };
    });
  }, [groupViews, scope, globalRules, partitionRules]);

  const groupRank = useMemo(
    () => new Map(navGroups.map((group, index) => [group.key, index])),
    [navGroups],
  );

  /* ------------------------------ 生效规则 ------------------------------ */

  // partition 作用域：全局 + 分区同 code 覆盖后的生效规则；global 作用域只用全局规则。
  const sortedRules = useMemo(() => {
    const list = scope === 'global' ? [...globalRules] : [...effectiveByCode.values()];
    return list.sort((left, right) => {
      const leftRank = groupRank.get(left.groupKey) ?? 999;
      const rightRank = groupRank.get(right.groupKey) ?? 999;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }, [scope, globalRules, effectiveByCode, groupRank]);

  const searchMode = search.trim().length > 0;
  const normalizedSearch = search.trim().toLowerCase();

  const filteredRules = useMemo(() => {
    return sortedRules.filter((rule) => {
      if (!searchMode && selectedGroup && rule.groupKey !== selectedGroup) return false;
      if (!searchMode) return true;
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
  }, [sortedRules, selectedGroup, searchMode, normalizedSearch]);

  const sectionGroups = useMemo(
    () => (searchMode || !selectedGroup ? navGroups : navGroups.filter((group) => group.key === selectedGroup)),
    [navGroups, searchMode, selectedGroup],
  );

  const listSections = useMemo(
    () =>
      sectionGroups
        .map((group) => ({
          group,
          groupRules: filteredRules.filter((rule) => rule.groupKey === group.key),
        }))
        .filter((section) => section.groupRules.length > 0),
    [sectionGroups, filteredRules],
  );

  const selectedGroupView = useMemo(
    () => (selectedGroup ? navGroups.find((group) => group.key === selectedGroup) ?? null : null),
    [navGroups, selectedGroup],
  );

  const navFilteredGroups = useMemo(() => {
    const query = navSearch.trim().toLowerCase();
    if (!query) return navGroups;
    return navGroups.filter((group) =>
      [group.name, group.industry, group.description, group.key].join('\n').toLowerCase().includes(query),
    );
  }, [navGroups, navSearch]);

  const totalRules = navGroups.reduce((sum, group) => sum + group.ruleCount, 0);
  const totalEnabled = navGroups.reduce((sum, group) => sum + group.enabledCount, 0);
  const totalApplied = navGroups.reduce((sum, group) => sum + group.appliedCount, 0);
  const totalStatus: GroupStatus =
    totalRules > 0 && totalEnabled >= totalRules ? 'on' : totalEnabled > 0 ? 'partial' : 'off';

  const headerTitle = searchMode
    ? `搜索结果 · ${search.trim()}`
    : selectedGroupView
      ? selectedGroupView.name
      : '全部规则';
  const headerDesc = searchMode
    ? `在全部 ${navGroups.length} 组中搜索 code / name / entityType / 校验器 / 地区，命中 ${filteredRules.length} 条规则。`
    : selectedGroupView
      ? selectedGroupView.description || '该分组暂无描述；可在规则编辑器中调整 groupKey。'
      : scope === 'global'
        ? '组织全局规则；分区可用同 code 覆盖 pattern / instruction / action / enabled。'
        : '全局规则 + 当前分区覆盖合并后的生效规则；同 code 时以分区规则为准；仅全局规则在本页为只读。';

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
    setSeedRule(null);
    setEditorOpen(true);
  };

  const openEdit = (rule: PrivacyRule) => {
    setEditingRule(rule);
    setSeedRule(null);
    setEditorOpen(true);
  };

  /** 基于全局规则创建同 code 的分区覆盖（在编辑器中确认字段）。 */
  const openOverride = (rule: PrivacyRule) => {
    if (!canWrite) {
      toast.warning('覆盖全局规则需要分区管理员及以上权限');
      return;
    }
    if (!effectivePartitionId) {
      toast.warning('请先选择分区');
      return;
    }
    setEditingRule(null);
    setSeedRule(rule);
    setEditorOpen(true);
  };

  /** 启停：分区覆盖行直接 PATCH；仅全局行则创建同 code 分区覆盖（停用也写覆盖）。 */
  const toggleRule = async (rule: PrivacyRule) => {
    if (!canWrite || toggleBusyId) return;
    if (scope === 'partition' && rule.scope === 'global') {
      if (!effectivePartitionId) {
        toast.warning('请先选择分区');
        return;
      }
      setToggleBusyId(rule.id);
      try {
        await api.privacy.createRule({
          ...overrideInputFrom(rule, !rule.enabled),
          scope: 'partition',
          partitionId: effectivePartitionId,
        });
        toast.success(
          `已在「${partitionName}」创建覆盖并${rule.enabled ? '停用' : '启用'}规则「${rule.name}」`,
        );
        await refreshRules();
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '创建分区覆盖失败');
      } finally {
        setToggleBusyId('');
      }
      return;
    }
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

  const selectGroup = (key: string) => {
    setSelectedGroup(key);
    if (searchMode) setSearch('');
  };

  /* ------------------------------ 规则表格列 ------------------------------ */

  const columns: Column<PrivacyRule>[] = [
    {
      key: 'rule',
      header: '规则',
      render: (rule) => (
        <div style={{ minWidth: 0 }}>
          <div className="hstack gap-6 wrap">
            <span className="mono small">{rule.code}</span>
            {rule.builtin ? <Badge tone="amber" size="sm">内置</Badge> : null}
            {scope === 'partition' && rule.scope === 'partition' && globalByCode.has(rule.code) ? (
              <Badge tone="cyan" size="sm" dot>分区覆盖</Badge>
            ) : null}
            {scope === 'partition' && rule.scope === 'partition' && !globalByCode.has(rule.code) ? (
              <Badge tone="violet" size="sm" dot>分区自定义</Badge>
            ) : null}
            {scope === 'partition' && rule.scope === 'global' ? (
              <Badge tone="slate" size="sm" dot>全局</Badge>
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
      width: 82,
      render: (rule) => (
        <Badge tone={rule.kind === 'prompt' ? 'pink' : 'violet'} size="sm">
          {PRIVACY_RULE_KIND_LABEL[rule.kind] ?? rule.kind}
        </Badge>
      ),
    },
    {
      key: 'guards',
      header: '校验 / 上下文',
      width: 158,
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
      width: 128,
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
      width: 58,
      align: 'center',
      render: (rule) => <span className="mono">{rule.priority}</span>,
    },
    {
      key: 'enabled',
      header: '启用',
      width: 58,
      align: 'center',
      render: (rule) => (
        <span
          onClick={(event) => event.stopPropagation()}
          title={
            scope === 'partition' && rule.scope === 'global'
              ? '启停会为当前分区创建同 code 覆盖规则'
              : undefined
          }
        >
          <Switch
            checked={rule.enabled}
            disabled={!canWrite || toggleBusyId === rule.id}
            onChange={() => void toggleRule(rule)}
          />
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 128,
      align: 'right',
      render: (rule) => {
        const overridable = scope === 'partition' && rule.scope === 'global';
        const editable = overridable ? false : canWrite;
        return (
          <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
            {overridable ? (
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                disabled={!canWrite || !effectivePartitionId || toggleBusyId === rule.id}
                title={
                  !effectivePartitionId
                    ? '请先选择分区'
                    : !canWrite
                      ? '覆盖全局规则需要分区管理员及以上权限'
                      : '在当前分区创建同 code 覆盖规则'
                }
                onClick={() => openOverride(rule)}
              >
                覆盖
              </Button>
            ) : null}
            {editable ? (
              <>
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
              </>
            ) : null}
            {!editable && !overridable ? <span className="tiny dim">只读</span> : null}
          </div>
        );
      },
    },
  ];

  /* ------------------------------ 左侧导航 ------------------------------ */

  const industryNav = (
    <aside className="privacy-industry-nav" aria-label="行业 / 领域导航">
      <div className="privacy-industry-head">
        <div className="section-title">行业 / 领域</div>
        <Badge tone="violet" size="sm">{navGroups.length} 组</Badge>
      </div>
      <SearchInput
        value={navSearch}
        onChange={setNavSearch}
        placeholder="搜索行业 / 分组…"
      />
      <div className="privacy-industry-list">
        <button
          type="button"
          className={`privacy-industry-item privacy-industry-item-all${searchMode || !selectedGroup ? ' is-active' : ''}`}
          onClick={() => selectGroup('')}
        >
          <span className="privacy-industry-line">
            <span className="privacy-industry-name">全部规则</span>
            <span className="privacy-industry-count mono">{totalEnabled}/{totalRules}</span>
          </span>
          <span className="privacy-industry-sub">
            <span className="truncate">
              {scope === 'global' ? '组织全局规则' : '全局 + 分区覆盖'}
            </span>
            <span className="privacy-industry-state">
              <span className={`privacy-industry-dot is-${totalStatus}`} />
              {GROUP_STATUS_LABEL[totalStatus]}
            </span>
          </span>
        </button>

        {navFilteredGroups.map((group) => {
          const status = groupStatus(group);
          const active = !searchMode && selectedGroup === group.key;
          return (
            <button
              key={group.key}
              type="button"
              className={`privacy-industry-item${active ? ' is-active' : ''}`}
              onClick={() => selectGroup(group.key)}
              title={group.description || group.name}
            >
              <span className="privacy-industry-line">
                <span className="privacy-industry-name truncate">{group.name}</span>
                <span className="privacy-industry-count mono">{group.enabledCount}/{group.ruleCount}</span>
              </span>
              <span className="privacy-industry-sub">
                <span className="truncate">{group.industry || '未分类'}</span>
                <span className="privacy-industry-state">
                  <span className={`privacy-industry-dot is-${status}`} />
                  {GROUP_STATUS_LABEL[status]}
                </span>
              </span>
              {group.appliedCount > 0 ? (
                <span className="privacy-industry-applied">分区覆盖 {group.appliedCount} 条</span>
              ) : null}
            </button>
          );
        })}

        {navFilteredGroups.length === 0 ? (
          <div className="privacy-industry-empty">没有匹配的分组，试试其他关键词。</div>
        ) : null}
      </div>
      <div className="privacy-industry-foot tiny dim">
        {scope === 'partition'
          ? '「启用本组 / 停用本组」会写入当前分区覆盖；同 code 覆盖全局。'
          : '全局规则由 owner 维护；分区覆盖在「当前分区」作用域中查看。'}
      </div>
    </aside>
  );

  /* ------------------------------ 右侧主区 ------------------------------ */

  const summaryItems = searchMode
    ? [
        { value: filteredRules.length, label: '命中规则' },
        { value: filteredRules.filter((rule) => rule.enabled).length, label: '已启用' },
        { value: filteredRules.filter((rule) => rule.scope === 'partition').length, label: '分区覆盖' },
      ]
    : selectedGroupView
      ? [
          { value: selectedGroupView.ruleCount, label: '条规则' },
          { value: selectedGroupView.enabledCount, label: '已启用' },
          { value: selectedGroupView.appliedCount, label: '分区覆盖' },
        ]
      : [
          { value: totalRules, label: '条规则' },
          { value: totalEnabled, label: '已启用' },
          { value: totalApplied, label: '分区覆盖' },
        ];

  const activeGroupStatus = selectedGroupView ? groupStatus(selectedGroupView) : totalStatus;

  const mainCard = (
    <Card>
      <div className="privacy-main-head">
        <div className="privacy-main-title">
          <div className="hstack gap-8 wrap">
            <span className="section-title">{headerTitle}</span>
            {!searchMode && selectedGroupView?.industry ? (
              <Badge tone="slate" size="sm">{selectedGroupView.industry}</Badge>
            ) : null}
            {!searchMode && selectedGroupView ? statusBadge(selectedGroupView) : null}
            {!searchMode && selectedGroupView?.appliedCount ? (
              <Badge tone="cyan" size="sm" dot>分区覆盖 {selectedGroupView.appliedCount}</Badge>
            ) : null}
            {scope === 'global' ? <Badge tone="violet" size="sm">全局作用域</Badge> : null}
            {scope === 'partition' && !effectivePartitionId ? (
              <Badge tone="amber" size="sm" dot>未选择分区</Badge>
            ) : null}
          </div>
          <div className="privacy-main-desc">{headerDesc}</div>
          <div className="privacy-main-counts">
            {summaryItems.map((item) => (
              <span className="privacy-count-chip" key={item.label}>
                <span className="mono strong">{item.value}</span>
                <span className="tiny dim"> {item.label}</span>
              </span>
            ))}
            {groupsQuery.loading ? <span className="tiny dim">分组统计读取中…</span> : null}
          </div>
        </div>

        <div className="hstack gap-6 wrap privacy-main-actions">
          {scope === 'partition' && selectedGroupView && !searchMode ? (
            <>
              <Button
                size="sm"
                variant={activeGroupStatus === 'on' ? 'ghost' : 'primary'}
                disabled={!canApplyGroups || Boolean(groupBusy) || activeGroupStatus === 'on'}
                loading={groupBusy === `${selectedGroupView.key}:on`}
                title={
                  !effectivePartitionId
                    ? '请先选择分区：整组启停写入分区覆盖'
                    : !canApplyGroups
                      ? '需要分区管理员及以上权限'
                      : activeGroupStatus === 'on'
                        ? '该组规则已全部启用'
                        : '为当前分区启用该组全部规则'
                }
                onClick={() => void applyGroup(selectedGroupView, true)}
              >
                启用本组
              </Button>
              <Button
                size="sm"
                disabled={
                  !canApplyGroups ||
                  Boolean(groupBusy) ||
                  (activeGroupStatus === 'off' && selectedGroupView.appliedCount === 0)
                }
                loading={groupBusy === `${selectedGroupView.key}:off`}
                title={
                  !effectivePartitionId
                    ? '请先选择分区'
                    : !canApplyGroups
                      ? '需要分区管理员及以上权限'
                      : activeGroupStatus === 'off' && selectedGroupView.appliedCount === 0
                        ? '该组没有启用的规则'
                        : '为当前分区停用该组全部规则'
                }
                onClick={() => void applyGroup(selectedGroupView, false)}
              >
                停用本组
              </Button>
            </>
          ) : null}
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
      </div>

      <div className="privacy-list-filters">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索全部规则 code / name / entityType…"
        />
        <span className="tiny dim nowrap">
          {searchMode || selectedGroup
            ? `${filteredRules.length} / ${sortedRules.length} 条`
            : `共 ${sortedRules.length} 条`}
        </span>
        {searchMode || selectedGroup ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch('');
              setSelectedGroup('');
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </div>

      {scope === 'partition' && !effectivePartitionId ? (
        <div className="privacy-main-callout">
          <Callout tone="amber" icon="alert">
            尚未选择分区：当前展示全局规则（只读）。选择分区后可启用 / 停用本组、覆盖全局规则与试跑预览。
          </Callout>
        </div>
      ) : null}

      {error && sortedRules.length > 0 ? (
        <div className="privacy-main-callout">
          <Callout tone="amber" icon="alert">
            刷新规则失败，已保留上次结果：{error}
            {scope === 'partition' && partitionQuery.error ? '（分区覆盖读取失败，当前可能只显示全局规则）' : ''}
          </Callout>
        </div>
      ) : null}

      {error && sortedRules.length === 0 ? (
        <div className="vstack gap-10" style={{ padding: 16 }}>
          <ErrorState message={error} onRetry={() => void refreshRules()} />
          <Callout tone="amber" icon="info">
            隐私规则接口可能尚未上线（<span className="mono">GET /api/privacy/rules</span>
            ）。后端就绪后点击「重试」即可；页面其他部分不受影响。
          </Callout>
        </div>
      ) : loading && sortedRules.length === 0 ? (
        <div className="vstack gap-8" style={{ padding: 16 }}>
          {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} h={48} style={{ borderRadius: 8 }} />)}
        </div>
      ) : listSections.length === 0 ? (
        <div style={{ padding: 16 }}>
          <EmptyState
            icon="shield"
            title={
              searchMode
                ? `没有匹配「${search.trim()}」的规则`
                : selectedGroupView
                  ? `「${selectedGroupView.name}」暂无可显示的规则`
                  : scope === 'global'
                    ? '还没有全局隐私规则'
                    : '这个分区还没有生效的规则'
            }
            description={
              searchMode
                ? '全局搜索会匹配 code / name / entityType / 校验器 / 地区；试试更短的关键词或清除筛选。'
                : selectedGroupView
                  ? '该分组在当前作用域下没有规则；可切换作用域，或新建一条规则并选择此分组。'
                  : scope === 'global'
                    ? '全局内置规则由服务端初始化（18 组 / 85 条，默认仅启用 email / phone / id_card / bank_card）。'
                    : '分区未覆盖任何规则且全局规则为空；新建规则后可在此查看生效结果。'
            }
            action={
              canWrite ? (
                <Button size="sm" icon="plus" onClick={openCreate}>新建规则</Button>
              ) : (
                <span className="tiny dim">
                  当前账号只读；需要{scope === 'global' ? ' owner ' : '管理员及以上 '}权限。
                </span>
              )
            }
          />
        </div>
      ) : (
        <div className="privacy-rule-sections">
          {listSections.map((section, index) => {
            const showSectionHead = Boolean(searchMode || !selectedGroup);
            return (
              <div className="privacy-rule-section" key={section.group.key}>
                {showSectionHead ? (
                  <div className="privacy-rule-section-head">
                    <div className="hstack gap-8 wrap" style={{ minWidth: 0 }}>
                      <span className="section-title truncate">{section.group.name}</span>
                      {section.group.industry ? (
                        <Badge tone="slate" size="sm">{section.group.industry}</Badge>
                      ) : null}
                      <span className="tiny dim">{section.groupRules.length} 条</span>
                      {statusBadge(section.group)}
                      {section.group.appliedCount ? (
                        <Badge tone="cyan" size="sm" dot>覆盖 {section.group.appliedCount}</Badge>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSearch('');
                        setSelectedGroup(section.group.key);
                      }}
                    >
                      只看本组
                    </Button>
                  </div>
                ) : null}
                <Table
                  columns={
                    index === 0
                      ? columns
                      : columns.map((column) => ({ ...column, header: '' }))
                  }
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
        desc="规则库按 18 个行业/领域分组（共 85 条内置规则）：左侧选择行业查看规则，右侧表格展示生效结果；支持正则、LLM 提示词、校验器与上下文关键词。"
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
            <Badge tone="violet" size="sm">schema v10 · 18 组</Badge>
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

      {groupsEndpointDown ? (
        <Callout tone="amber" icon="info">
          分组统计接口暂不可用（<span className="mono">GET /api/privacy/groups</span>
          ），当前按规则列表本地汇总启用 / 覆盖数；整组启停仍需后端
          <span className="mono"> POST /api/privacy/groups/:key/apply </span> 上线。
          {groupsQuery.error ? <span className="tiny dim">（{groupsQuery.error}）</span> : null}
        </Callout>
      ) : null}

      <div className="privacy-layout">
        {industryNav}
        <section className="privacy-main">
          {mainCard}
          <PrivacyPreviewCard
            partitionId={effectivePartitionId}
            partitionName={partitionName}
            disabled={!effectivePartitionId}
          />
        </section>
      </div>

      <Callout tone="slate" icon="info">
        规则变更可触发 <span className="mono">POST /api/partitions/:partition/privacy/rescan</span> 重扫历史记忆；
        内置规则库由服务端按 v9 schema 初始化（18 组 / 85 条，仅 email / phone / id_card / bank_card 默认启用）。
      </Callout>

      <PrivacyRuleEditor
        open={editorOpen}
        scope={scope}
        partitionId={effectivePartitionId}
        rule={editingRule}
        seed={seedRule}
        defaultGroupKey={selectedGroup || undefined}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setSeedRule(null);
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
            ? deleteTarget.scope === 'partition'
              ? `将删除分区规则「${deleteTarget.name}」（${deleteTarget.code}）。删除后该分区会回退到同 code 的全局规则（若有）。`
              : `将删除全局规则「${deleteTarget.name}」（${deleteTarget.code}）。已有同 code 分区覆盖的分区不受影响。`
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
