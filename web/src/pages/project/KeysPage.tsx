import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ApiKey, ApiKeyWithSecret } from '@shared';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtDateTime, fmtFullDateTime, fmtInt, fmtRelative, maskKey } from '@lib/format.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { api, ApiError } from '@lib/api.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHead,
  Table,
  useToast,
  type Column,
} from '@ui';
import { PendingProject, TableScroller } from '../../components/project-ops/common.tsx';
import { KeyCreateModal } from '../../components/project-ops/keys/KeyCreateModal.tsx';
import { KeySecretModal } from '../../components/project-ops/keys/KeySecretModal.tsx';
import { KeyRotateModal } from '../../components/project-ops/keys/KeyRotateModal.tsx';
import { ScopeBadges } from '../../components/project-ops/keys/ScopeBadges.tsx';
import { KEY_LIFECYCLE_META, keyLifecycle } from '../../components/project-ops/keys/keyMeta.ts';

function dimmed(revoked: boolean, node: ReactNode) {
  return <span style={{ opacity: revoked ? 0.45 : 1 }}>{node}</span>;
}

export function KeysPage() {
  const { project, loading: projectLoading, error: projectError, refresh: refreshProject } = useProjectContext();
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const projectId = project?.id ?? routeProjectId ?? '';

  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyWithSecret | null>(null);
  const [secretMode, setSecretMode] = useState<'create' | 'rotate'>('create');
  const [secretGrace, setSecretGrace] = useState(0);
  const [rotateTarget, setRotateTarget] = useState<ApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const { data, loading, error, refresh } = useAsync(
    () => api.projects.keys.list(projectId),
    [projectId],
    Boolean(projectId),
  );
  const { data: members } = useAsync(
    () => api.projects.members.list(projectId),
    [projectId],
    Boolean(projectId),
  );
  const memberName = (userId: string) => members?.find((member) => member.userId === userId)?.name ?? userId;

  const keys = data ?? [];
  const activeCount = keys.filter((key) => keyLifecycle(key) === 'active').length;
  const expiringCount = keys.filter((key) => keyLifecycle(key) === 'expiring').length;
  const expiredCount = keys.filter((key) => keyLifecycle(key) === 'expired').length;
  const revokedCount = keys.filter((key) => keyLifecycle(key) === 'revoked').length;

  const closeSecret = () => {
    setCreated(null);
    void refresh();
  };

  const confirmRevoke = async () => {
    if (!revokeTarget || !projectId) return;
    setRevoking(true);
    try {
      await api.projects.keys.revoke(projectId, revokeTarget.id);
      toast.success(`密钥「${revokeTarget.name}」已吊销`);
      setRevokeTarget(null);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '吊销密钥失败，请稍后重试。');
    } finally {
      setRevoking(false);
    }
  };

  if (!projectId) {
    return (
      <div className="page">
        <PageHead eyebrow="项目 · 安全" title="API 密钥" desc="管理项目级 API 访问凭据。" />
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

  const columns: Column<ApiKey>[] = [
    {
      key: 'name',
      header: '名称',
      width: 210,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          <div className="vstack gap-4">
            <div className="hstack gap-6 wrap">
              <span className="strong small">{key.name}</span>
              <Badge tone={key.kind === 'org' ? 'amber' : 'cyan'} size="sm">
                {key.kind === 'org' ? '组织密钥' : '分区密钥'}
              </Badge>
            </div>
            <span className="tiny dim">限流 {fmtInt(key.rateLimitPerMin)} 次 / 分钟</span>
          </div>,
        ),
    },
    {
      key: 'prefix',
      header: '前缀',
      width: 156,
      mono: true,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          <span className="mono small" title={key.prefix}>
            {maskKey(key.prefix)}
          </span>,
        ),
    },
    {
      key: 'scopes',
      header: '作用域',
      render: (key) => dimmed(Boolean(key.revokedAt), <ScopeBadges scopes={key.scopes} size="sm" />),
    },
    {
      key: 'expiresAt',
      header: '有效期',
      width: 150,
      render: (key) => {
        const lifecycle = keyLifecycle(key);
        const color =
          lifecycle === 'expired' ? 'var(--red)' : lifecycle === 'expiring' ? 'var(--amber)' : undefined;
        if (!key.expiresAt) {
          return dimmed(Boolean(key.revokedAt), <span className="tiny dim">永不过期</span>);
        }
        return dimmed(
          Boolean(key.revokedAt),
          <div className="vstack gap-2">
            <span
              className="small mono nowrap"
              style={{ color }}
              title={fmtFullDateTime(key.expiresAt)}
            >
              {fmtDateTime(key.expiresAt)}
            </span>
            <span className="tiny dim" style={color ? { color } : undefined}>
              {fmtRelative(key.expiresAt)}
            </span>
          </div>,
        );
      },
    },
    {
      key: 'allowedIps',
      header: 'IP 白名单',
      width: 190,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          (key.allowedIps ?? []).length === 0 ? (
            <span className="tiny dim">不限</span>
          ) : (
            <span className="chip-row">
              {(key.allowedIps ?? []).slice(0, 2).map((ip) => (
                <span className="chip mono" key={ip} title={ip}>
                  {ip}
                </span>
              ))}
              {(key.allowedIps ?? []).length > 2 ? (
                <span className="chip" title={(key.allowedIps ?? []).slice(2).join('、')}>
                  +{(key.allowedIps ?? []).length - 2}
                </span>
              ) : null}
            </span>
          ),
        ),
    },
    {
      key: 'lifecycle',
      header: '创建 / 最近使用',
      width: 168,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          <div className="vstack gap-2">
            <span className="small muted truncate" title={key.createdBy} style={{ maxWidth: 160 }}>
              {memberName(key.createdBy)}
            </span>
            <span className="tiny dim" title={key.lastUsedAt ? fmtFullDateTime(key.lastUsedAt) : undefined}>
              {key.lastUsedAt ? fmtRelative(key.lastUsedAt) : '从未使用'}
            </span>
          </div>,
        ),
    },
    {
      key: 'status',
      header: '状态',
      width: 108,
      render: (key) => {
        const meta = KEY_LIFECYCLE_META[keyLifecycle(key)];
        return dimmed(
          Boolean(key.revokedAt),
          <Badge tone={meta.tone} size="sm" dot>
            {meta.label}
          </Badge>,
        );
      },
    },
    {
      key: 'actions',
      header: '操作',
      width: 156,
      align: 'right',
      render: (key) =>
        key.revokedAt ? (
          <span className="tiny dim">—</span>
        ) : (
          <div className="hstack gap-4" style={{ justifyContent: 'flex-end' }}>
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              title="生成新密钥，并按宽限期下线当前密钥"
              onClick={() => setRotateTarget(key)}
            >
              轮换
            </Button>
            <Button size="sm" variant="danger" onClick={() => setRevokeTarget(key)}>
              吊销
            </Button>
          </div>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 安全"
        title="API 密钥"
        desc="管理当前分区的 API 密钥（分区密钥）。分区密钥只能访问本分区；组织级密钥请在「组织设置」管理。"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            创建密钥
          </Button>
        }
      />

      <Callout tone="amber" icon="lock">
        <div className="vstack gap-4">
          <div>
            <strong>完整密钥仅在创建时显示一次。</strong>
            控制台只保留前缀，请创建后立即复制到密钥管理服务或环境变量。
          </div>
          <div>
            密钥按项目隔离，无法跨项目访问；建议为不同服务分别创建，并设置有效期与 IP 白名单缩小泄露影响面。
          </div>
          <div>
            轮换会生成新密钥并按宽限期自动下线旧密钥：宽限期结束前请完成所有调用方替换。
          </div>
        </div>
      </Callout>

      {isOwner ? (
        <Callout tone="cyan" icon="globe">
          <div className="between gap-12 wrap">
            <div className="vstack gap-4">
              <span>
                <strong>组织级密钥在「组织设置」统一管理。</strong>
                组织密钥可访问/创建本组织任意分区，通常用于按工作区自动建分区的客户端（如 DSH
                插件）；本页只管理当前分区的密钥。
              </span>
            </div>
            <Button size="sm" variant="outline" icon="arrowRight" onClick={() => navigate('/org')}>
              前往组织设置
            </Button>
          </div>
        </Callout>
      ) : null}

      {error && !data ? (
        <Card pad>
          <ErrorState
            message={error}
            onRetry={() => {
              void refresh();
            }}
          />
        </Card>
      ) : (
        <>
          {error ? (
            <Callout tone="red" icon="alert">
              刷新密钥列表失败：{error}
            </Callout>
          ) : null}
          <Card>
            <div className="toolbar" style={{ padding: '16px 20px' }}>
              <div className="toolbar-left">
                <span className="section-title">密钥列表</span>
                <Badge tone="slate" size="sm">
                  共 {keys.length} 个
                </Badge>
                <Badge tone={activeCount > 0 ? 'green' : 'slate'} size="sm">
                  生效 {activeCount} 个
                </Badge>
                {expiringCount > 0 ? (
                  <Badge tone="amber" size="sm">即将过期 {expiringCount} 个</Badge>
                ) : null}
                {expiredCount > 0 ? <Badge tone="red" size="sm">已过期 {expiredCount} 个</Badge> : null}
                {revokedCount > 0 ? <Badge tone="slate" size="sm">已吊销 {revokedCount} 个</Badge> : null}
              </div>
              <div className="toolbar-right">
                <Button
                  size="sm"
                  icon="refresh"
                  loading={loading}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  刷新
                </Button>
              </div>
            </div>
            <TableScroller minWidth={keys.length ? 1160 : undefined}>
              <Table
                columns={columns}
                rows={keys}
                rowKey={(key) => key.id}
                loading={loading && !data}
                empty={
                  <EmptyState
                    icon="key"
                    title="还没有 API 密钥"
                    description="创建密钥后，服务端即可通过 Bearer 认证调用记忆写入、检索与图谱接口。"
                    action={
                      <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                        创建第一个密钥
                      </Button>
                    }
                  />
                }
              />
            </TableScroller>
          </Card>
        </>
      )}

      <KeyCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        onCreated={(key) => {
          setCreateOpen(false);
          setSecretMode('create');
          setSecretGrace(0);
          setCreated(key);
          void refresh();
        }}
      />

      <KeyRotateModal
        projectId={projectId}
        target={rotateTarget}
        onClose={() => setRotateTarget(null)}
        onRotated={(key, graceHours) => {
          setRotateTarget(null);
          setSecretMode('rotate');
          setSecretGrace(graceHours);
          setCreated(key);
          toast.success('密钥已轮换，请立即保存新密钥');
          void refresh();
        }}
      />

      <KeySecretModal created={created} mode={secretMode} graceHours={secretGrace} onClose={closeSecret} />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          void confirmRevoke();
        }}
        loading={revoking}
        title="吊销 API 密钥"
        description={
          revokeTarget
            ? `确定吊销「${revokeTarget.name}」吗？使用该密钥的服务会立即失去访问权限，且此操作无法撤销。`
            : undefined
        }
        confirmLabel="确认吊销"
      />
    </div>
  );
}
