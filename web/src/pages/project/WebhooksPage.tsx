import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ROLE_RANK } from '@shared';
import type { Webhook, WebhookWithSecret } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { useAuth } from '@lib/auth.tsx';
import { useAsync } from '@lib/hooks.ts';
import { fmtInt, fmtMs, fmtPct } from '@lib/format.ts';
import { ROLE_LABEL } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHead,
  Skeleton,
  Stat,
  useToast,
} from '@ui';
import { PendingProject } from '../../components/project-ops/common.tsx';
import { WebhookDeliveriesDrawer } from '../../components/webhooks/WebhookDeliveriesDrawer.tsx';
import { WebhookEventHelp } from '../../components/webhooks/WebhookEventHelp.tsx';
import { WebhookFormModal } from '../../components/webhooks/WebhookFormModal.tsx';
import { WebhookSecretModal } from '../../components/webhooks/WebhookSecretModal.tsx';
import { WebhookTable } from '../../components/webhooks/WebhookTable.tsx';
import { WebhookTestModal, type WebhookTestOutcome } from '../../components/webhooks/WebhookTestModal.tsx';
import {
  SIGNATURE_HEADER,
  SIGNING_BASE,
  mergeEventOptions,
  successRate,
  successRateTone,
} from '../../components/webhooks/shared.tsx';

interface SecretState {
  webhook: WebhookWithSecret;
  mode: 'create' | 'rotate';
}

export function WebhooksPage() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading, error: projectError, refresh: refreshProject } = useProjectContext();
  const projectId = project?.id ?? routeProjectId ?? '';
  const { user } = useAuth();
  const toast = useToast();

  const [forbidden, setForbidden] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Webhook | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Webhook | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<SecretState | null>(null);
  const [testOutcome, setTestOutcome] = useState<WebhookTestOutcome | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<Webhook | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const listAsync = useAsync(
    async () => {
      try {
        const result = await api.webhooks.list(projectId);
        setForbidden(false);
        return result;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
        throw cause;
      }
    },
    [projectId],
    Boolean(projectId),
  );

  const statsAsync = useAsync(() => api.webhooks.stats(projectId), [projectId], Boolean(projectId));

  const eventTypesAsync = useAsync(() => api.webhooks.eventTypes(), [], Boolean(projectId));
  const eventOptions = useMemo(() => mergeEventOptions(eventTypesAsync.data), [eventTypesAsync.data]);

  // 写入类接口要求项目管理员：组织管理员直接放行，其余角色读取项目成员角色。
  const isOrgAdmin = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);
  const membersAsync = useAsync(
    () => api.projects.members.list(projectId),
    [projectId, isOrgAdmin, user?.id],
    Boolean(projectId) && Boolean(user) && !isOrgAdmin,
  );
  const memberRole = membersAsync.data?.find((member) => member.userId === user?.id)?.role ?? null;
  const effectiveRole = user ? (isOrgAdmin ? user.role : memberRole) : null;
  const canManage = effectiveRole === 'admin' || effectiveRole === 'owner';
  const readOnly = !canManage;

  const webhooks = listAsync.data ?? [];
  const stats = statsAsync.data;
  const statsLoading = statsAsync.loading && !stats;
  const refreshing = listAsync.loading || statsAsync.loading;
  const enabledCount = webhooks.filter((webhook) => webhook.enabled).length;
  const disabledCount = webhooks.length - enabledCount;
  const failingCount = webhooks.filter((webhook) => webhook.failureCount > 0).length;
  const rate = successRate(stats);

  const refreshAll = () => {
    void listAsync.refresh();
    void statsAsync.refresh();
  };

  const handleToggle = async (webhook: Webhook, enabled: boolean) => {
    if (readOnly || togglingId) return;
    setTogglingId(webhook.id);
    try {
      await api.webhooks.update(webhook.id, { enabled });
      toast.success(enabled ? `已启用「${webhook.name}」` : `已暂停「${webhook.name}」的投递`);
      await listAsync.refresh();
      void statsAsync.refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '更新订阅状态失败，请稍后重试。');
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (webhook: Webhook) => {
    if (readOnly || testingId) return;
    setTestingId(webhook.id);
    try {
      const result = await api.webhooks.test(webhook.id);
      setTestOutcome({ webhook, result, at: new Date().toISOString() });
      if (result.status === 'success') {
        toast.success(`测试投递成功 · HTTP ${result.responseStatus ?? '—'}`);
      } else {
        toast.error(result.error ?? '测试投递未成功，请查看详情与投递记录。');
      }
      refreshAll();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '测试投递失败，请稍后重试。');
    } finally {
      setTestingId(null);
    }
  };

  const handleCreated = (created: WebhookWithSecret) => {
    setCreateOpen(false);
    setSecret({ webhook: created, mode: 'create' });
    toast.success('订阅已创建，请立即保存签名密钥');
    refreshAll();
  };

  const handleUpdated = (updated: Webhook) => {
    setEditTarget(null);
    toast.success(`已保存「${updated.name}」`);
    refreshAll();
  };

  const confirmRotate = async () => {
    if (!rotateTarget) return;
    setRotating(true);
    try {
      const updated = await api.webhooks.rotateSecret(rotateTarget.id);
      const name = rotateTarget.name;
      setRotateTarget(null);
      setSecret({ webhook: updated, mode: 'rotate' });
      toast.success(`「${name}」的签名密钥已轮换`);
      refreshAll();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '轮换签名密钥失败，请稍后重试。');
    } finally {
      setRotating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const target = deleteTarget;
      await api.webhooks.remove(target.id);
      setDeleteTarget(null);
      if (deliveryTarget?.id === target.id) setDeliveryTarget(null);
      toast.success(`已删除订阅「${target.name}」`);
      refreshAll();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '删除订阅失败，请稍后重试。');
    } finally {
      setDeleting(false);
    }
  };

  if (!projectId) {
    return (
      <div className="page">
        <PageHead
          eyebrow="项目 · 集成"
          title="事件订阅"
          desc="把记忆与任务事件以 HMAC 签名的方式推送到你的服务，失败自动重试。"
        />
        <PendingProject
          loading={projectLoading}
          error={projectError}
          onRetry={() => {
            void refreshProject();
          }}
        />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="page">
        <PageHead
          eyebrow="项目 · 集成"
          title="事件订阅"
          desc="把记忆与任务事件以 HMAC 签名的方式推送到你的服务，失败自动重试。"
        />
        <Callout tone="amber" icon="lock">
          <strong>没有访问事件订阅的权限。</strong>
          事件订阅涉及对外推送地址与签名密钥，仅项目成员可查看。请确认当前账号已被加入该项目，或联系组织管理员调整权限。
        </Callout>
        <Card pad>
          <ErrorState
            message={listAsync.error ?? '无法加载事件订阅列表。'}
            onRetry={() => {
              void listAsync.refresh();
            }}
          />
        </Card>
        <WebhookEventHelp options={eventOptions} />
      </div>
    );
  }

  const listLoading = listAsync.loading && !listAsync.data;

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 集成"
        title="事件订阅"
        desc="把记忆与任务事件以 HMAC 签名的方式推送到你的服务，失败自动重试。"
        actions={
          <>
            <Button icon="refresh" loading={refreshing} onClick={refreshAll}>
              刷新
            </Button>
            {readOnly ? null : (
              <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                新建订阅
              </Button>
            )}
          </>
        }
      />

      {readOnly ? (
        <Callout tone="amber" icon="lock">
          <strong>当前账号没有事件订阅的管理权限。</strong>
          可以查看订阅配置、签名说明与投递记录；新建、编辑、测试、轮换、删除与重放需要项目管理员（admin / owner）。
          {effectiveRole ? `当前角色：${ROLE_LABEL[effectiveRole]}。` : ''}
          如需管理事件订阅，请联系组织管理员调整项目角色。
        </Callout>
      ) : null}

      <Callout tone="cyan" icon="shield">
        <div className="vstack gap-4">
          <div>
            <strong>所有投递都带签名。</strong>
            请使用原始请求体与订阅密钥校验请求头
            <span className="mono"> {SIGNATURE_HEADER}: t=…,v1=…</span>
            ：对
            <span className="mono"> {SIGNING_BASE} </span>
            计算 HMAC-SHA256，并确认时间戳在 5 分钟内。
          </div>
          <div>投递失败会按指数退避自动重试，连续失败后进入死信；可在投递记录中查看每次尝试并手动重放。</div>
        </div>
      </Callout>

      <div className="kpi-grid">
        <Stat
          label="订阅数"
          value={listLoading ? <Skeleton w={56} h={24} /> : fmtInt(webhooks.length)}
          unit="个"
          icon="bell"
          tone="violet"
          hint={
            webhooks.length > 0
              ? `启用 ${fmtInt(enabledCount)} · 停用 ${fmtInt(disabledCount)}`
              : '尚未创建订阅'
          }
        />
        <Stat
          label="启用数"
          value={listLoading ? <Skeleton w={44} h={24} /> : fmtInt(enabledCount)}
          unit="个"
          icon="zap"
          tone="green"
          hint={
            webhooks.length > 0
              ? `占比 ${fmtPct((enabledCount / webhooks.length) * 100, 0)}`
              : '暂无订阅可启用'
          }
        />
        <Stat
          label="近 24h 投递"
          value={statsLoading ? <Skeleton w={56} h={24} /> : stats ? fmtInt(stats.last24h) : '—'}
          unit="次"
          icon="activity"
          tone="cyan"
          hint={
            stats
              ? stats.total > 0
                ? `平均延迟 ${fmtMs(stats.avgLatencyMs)}${stats.pending > 0 ? ` · 待投递 ${fmtInt(stats.pending)}` : ''}`
                : '尚无投递记录'
              : '统计暂不可用'
          }
        />
        <Stat
          label="成功率"
          value={statsLoading ? <Skeleton w={64} h={24} /> : rate === null ? '—' : fmtPct(rate)}
          icon="gauge"
          tone={successRateTone(rate)}
          hint={
            stats
              ? `成功 ${fmtInt(stats.success)} · 失败 ${fmtInt(stats.failed)} · 死信 ${fmtInt(stats.dead)}`
              : '统计暂不可用'
          }
        />
      </div>

      {statsAsync.error ? (
        <Callout tone="amber" icon="alert">
          投递统计暂不可用：{statsAsync.error}。订阅列表与投递记录不受影响。
        </Callout>
      ) : null}

      {listAsync.error && listAsync.data ? (
        <Callout tone="red" icon="alert">
          刷新订阅列表失败，当前展示上一次成功获取的数据：{listAsync.error}
        </Callout>
      ) : null}

      {listAsync.error && !listAsync.data ? (
        <Card pad>
          <ErrorState
            message={listAsync.error}
            onRetry={() => {
              void listAsync.refresh();
            }}
          />
        </Card>
      ) : (
        <Card>
          <div className="toolbar" style={{ padding: '16px 20px' }}>
            <div className="toolbar-left">
              <span className="section-title">订阅列表</span>
              <Badge tone="slate" size="sm">
                共 {webhooks.length} 个
              </Badge>
              <Badge tone={enabledCount > 0 ? 'green' : 'slate'} size="sm">
                启用 {enabledCount} 个
              </Badge>
              {failingCount > 0 ? (
                <Badge tone="red" size="sm">
                  有失败记录 {failingCount} 个
                </Badge>
              ) : null}
            </div>
            <div className="toolbar-right">
              <span className="tiny dim">点击行可查看投递记录</span>
            </div>
          </div>
          <WebhookTable
            webhooks={webhooks}
            loading={listLoading}
            readOnly={readOnly}
            togglingId={togglingId}
            testingId={testingId}
            eventOptions={eventOptions}
            empty={
              <EmptyState
                icon="bell"
                title="还没有事件订阅"
                description={
                  readOnly
                    ? '当前项目尚未配置事件订阅。只读角色无法创建，请联系组织管理员。'
                    : '订阅后，记忆写入、更新、删除与任务完成等事件会以带签名的 POST 请求推送到你的服务。'
                }
                action={
                  readOnly ? undefined : (
                    <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                      创建第一个订阅
                    </Button>
                  )
                }
              />
            }
            onToggle={(webhook, enabled) => {
              void handleToggle(webhook, enabled);
            }}
            onTest={(webhook) => {
              void handleTest(webhook);
            }}
            onRotate={setRotateTarget}
            onEdit={setEditTarget}
            onDelete={setDeleteTarget}
            onDeliveries={setDeliveryTarget}
          />
        </Card>
      )}

      <WebhookEventHelp options={eventOptions} />

      <WebhookFormModal
        open={createOpen}
        mode="create"
        projectId={projectId}
        webhook={null}
        options={eventOptions}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        onUpdated={handleUpdated}
      />

      <WebhookFormModal
        open={Boolean(editTarget)}
        mode="edit"
        projectId={projectId}
        webhook={editTarget}
        options={eventOptions}
        onClose={() => setEditTarget(null)}
        onCreated={handleCreated}
        onUpdated={handleUpdated}
      />

      {secret ? (
        <WebhookSecretModal
          webhook={secret.webhook}
          mode={secret.mode}
          onClose={() => {
            setSecret(null);
            refreshAll();
          }}
        />
      ) : null}

      {testOutcome ? (
        <WebhookTestModal
          outcome={testOutcome}
          onClose={() => setTestOutcome(null)}
          onViewDeliveries={(webhook) => {
            setTestOutcome(null);
            setDeliveryTarget(webhook);
          }}
        />
      ) : null}

      {deliveryTarget ? (
        <WebhookDeliveriesDrawer
          key={deliveryTarget.id}
          webhook={deliveryTarget}
          eventOptions={eventOptions}
          canReplay={canManage}
          onClose={() => setDeliveryTarget(null)}
          onChanged={refreshAll}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(rotateTarget)}
        onClose={() => setRotateTarget(null)}
        onConfirm={() => {
          void confirmRotate();
        }}
        loading={rotating}
        title="轮换签名密钥"
        description={
          rotateTarget
            ? `确定轮换「${rotateTarget.name}」的签名密钥吗？旧密钥会立即失效，所有消费方必须同步替换为新密钥，否则签名校验将失败。`
            : undefined
        }
        confirmLabel="确认轮换"
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          void confirmDelete();
        }}
        loading={deleting}
        title="删除事件订阅"
        description={
          deleteTarget
            ? `确定删除「${deleteTarget.name}」吗？删除后不再向该地址推送事件，签名密钥立即作废，已有投递记录将无法继续重放。`
            : undefined
        }
        confirmLabel="确认删除"
      />
    </div>
  );
}
