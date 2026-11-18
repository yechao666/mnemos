import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PrivacyRule, PrivacyRuleScope, PrivacyScanResult } from '@lib/types.ts';
import {
  PRIVACY_ACTION_LABEL,
  PRIVACY_MASK_MODE_LABEL,
  PRIVACY_PREVIEW_SAMPLE,
  PRIVACY_RULE_KIND_LABEL,
  PRIVACY_SCOPE_OPTIONS,
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

function maskSummary(rule: PrivacyRule): string {
  if (rule.action === 'placeholder') return '→ {{pii_xxxxxxxx}}';
  const label = PRIVACY_MASK_MODE_LABEL[rule.maskMode] ?? rule.maskMode;
  if (rule.maskMode === 'keepFirstLast') return `${label} ${rule.maskKeepFirst}/${rule.maskKeepLast}`;
  if (rule.maskMode === 'keepLast') return `${label} ${rule.maskKeepLast}`;
  return label;
}

/**
 * 隐私规则页（v6.2）：全局 / 当前分区两套作用域。
 *
 *  - 分区路由 `/partitions/:p/privacy`：分区规则优先展示，可切到全局；
 *  - 组织路由 `/org/privacy`：默认全局规则，分区下拉用于试跑与查看覆盖。
 *  - 规则改动后写入侧异步重扫；prompt 规则需 LLM + privacyLlmEnabled。
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

  const role = user?.role;
  const canWrite = scope === 'global' ? role === 'owner' : Boolean(role && ROLE_RANK[role] >= ROLE_RANK.admin);
  const settings = activePartition?.settings;
  const piiRedaction = settings?.piiRedaction === 'basic' ? 'basic' : 'off';
  const llmEnabled = settings?.privacyLlmEnabled === true;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<PrivacyRule | null>(null);
  const [toggleBusyId, setToggleBusyId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PrivacyRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refreshRules = async () => {
    await Promise.all([
      globalQuery.refresh(),
      effectivePartitionId ? partitionQuery.refresh() : Promise.resolve(null),
    ]);
  };

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
      key: 'action',
      header: '动作 / 打码',
      width: 168,
      render: (rule) => (
        <div className="vstack gap-2">
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

  const listCard = (
    <Card>
      <div style={{ padding: '14px 16px 0' }}>
        <SectionHead
          title={scope === 'global' ? '全局规则' : `分区规则 · ${partitionName}`}
          desc={
            scope === 'global'
              ? '组织默认规则；分区可用同 code 的规则覆盖（含停用）。全局写权限仅 owner。'
              : '只影响当前分区；同 code 时覆盖全局规则的 pattern / instruction / action / enabled。'
          }
          actions={
            <div className="hstack gap-8">
              <Badge tone="slate" size="sm">{rules.length} 条</Badge>
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
      ) : (
        <Table
          columns={columns}
          rows={rules}
          rowKey={(rule) => rule.id}
          loading={loading && rules.length === 0}
          empty={
            <EmptyState
              icon="shield"
              title={scope === 'global' ? '还没有全局隐私规则' : '这个分区还没有自定义规则'}
              description={
                scope === 'global'
                  ? '全局内置规则由服务端初始化（email / id_card / phone / bank_card 等）；也可以新建自定义正则或提示词规则。'
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
          }
        />
      )}
    </Card>
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="隐私规则"
        title="隐私规则管理"
        desc="把 PII 脱敏从写死逻辑升级为可维护规则：全局默认 + 分区覆盖，支持正则扫描与 LLM 提示词抽取；写入支持占位符 + 映射表。"
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
              <span className="mono"> priority </span>升序执行（小者先）。prompt 规则需 LLM 且分区开启
              <span className="mono"> privacyLlmEnabled</span>，不可用时静默回退正则。
            </div>
          </div>
          <div className="hstack gap-6 wrap">
            <Badge tone={piiRedaction === 'basic' ? 'green' : 'slate'} size="sm" dot>
              PII 总开关 {piiRedaction}
            </Badge>
            <Badge tone={llmEnabled ? 'green' : 'slate'} size="sm" dot>
              提示词规则 {llmEnabled ? '已开启' : '未开启'}
            </Badge>
            <Badge tone="violet" size="sm">schema v8</Badge>
          </div>
        </div>

        {!activePartition && selectedPartitionId && partitionDetail.loading ? (
          <div className="tiny dim mt-10">正在读取分区设置（piiRedaction / privacyLlmEnabled）…</div>
        ) : !activePartition && !effectivePartitionId ? (
          <div className="mt-10">
            <Callout tone="amber" icon="alert">
              尚未选择分区，无法试跑预览。请先从分区列表进入某个分区，或在组织级隐私规则页选择分区。
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

      {listCard}

      <PrivacyPreviewCard
        partitionId={effectivePartitionId}
        partitionName={partitionName}
        disabled={!effectivePartitionId}
      />

      <Callout tone="slate" icon="info">
        规则变更可触发 <span className="mono">POST /api/partitions/:partition/privacy/rescan</span> 重扫历史记忆；
        内置规则由服务端初始化（email / id_card / phone / bank_card 为 regex，name / address / credential / medical 为 prompt 默认关闭）。
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
