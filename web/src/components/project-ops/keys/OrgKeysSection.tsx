import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApiKey, ApiKeyWithSecret, Project } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtDateTime, fmtFullDateTime, fmtInt, fmtRelative, maskKey } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Table,
  useToast,
  type Column,
} from '@ui';
import { TableScroller } from '../common.tsx';
import { KEY_LIFECYCLE_META, keyLifecycle } from './keyMeta.ts';
import { ScopeBadges } from './ScopeBadges.tsx';
import { OrgKeyCreateModal } from './OrgKeyCreateModal.tsx';
import { KeySecretModal } from './KeySecretModal.tsx';

/** 吊销中的密钥降低透明度，避免与生效密钥混淆。 */
function dimmed(revoked: boolean, node: ReactNode) {
  return <span style={{ opacity: revoked ? 0.45 : 1 }}>{node}</span>;
}

/**
 * 组织密钥区块（仅组织 owner）：供「按工作区自动建分区」的客户端（DSH 插件）使用。
 * 组织密钥可访问/创建本组织任意分区，属于高权限凭据。
 */
export function OrgKeysSection({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyWithSecret | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const { data, loading, error, refresh } = useAsync(() => api.org.keys.list(), []);
  const keys = data ?? [];
  const activeCount = keys.filter((key) => keyLifecycle(key) === 'active').length;
  const expiringCount = keys.filter((key) => keyLifecycle(key) === 'expiring').length;
  const expiredCount = keys.filter((key) => keyLifecycle(key) === 'expired').length;
  const revokedCount = keys.filter((key) => keyLifecycle(key) === 'revoked').length;
  const hasPartition = projects.length > 0;

  const projectName = (projectId: string): string =>
    projects.find((project) => project.id === projectId)?.name ?? projectId;

  const closeSecret = () => {
    setCreated(null);
    void refresh();
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.org.keys.revoke(revokeTarget.id);
      toast.success(`组织密钥「${revokeTarget.name}」已吊销`);
      setRevokeTarget(null);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '吊销组织密钥失败，请稍后重试。');
    } finally {
      setRevoking(false);
    }
  };

  const columns: Column<ApiKey>[] = [
    {
      key: 'name',
      header: '名称',
      width: 240,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          <div className="vstack gap-4">
            <span className="strong small">{key.name}</span>
            <span className="tiny dim truncate" title={`锚点分区：${projectName(key.projectId)}`}>
              锚点分区 {projectName(key.projectId)} · 限流 {fmtInt(key.rateLimitPerMin)} 次 / 分钟
            </span>
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
            <span className="small mono nowrap" style={{ color }} title={fmtFullDateTime(key.expiresAt)}>
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
      width: 160,
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
      key: 'lastUsedAt',
      header: '最近使用',
      width: 128,
      render: (key) =>
        dimmed(
          Boolean(key.revokedAt),
          <span className="tiny muted" title={key.lastUsedAt ? fmtFullDateTime(key.lastUsedAt) : undefined}>
            {key.lastUsedAt ? fmtRelative(key.lastUsedAt) : '从未使用'}
          </span>,
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
      width: 96,
      align: 'right',
      render: (key) =>
        key.revokedAt ? (
          <span className="tiny dim">—</span>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setRevokeTarget(key)}>
            吊销
          </Button>
        ),
    },
  ];

  return (
    <>
      <Callout tone="amber" icon="lock">
        <div className="vstack gap-4">
          <div>
            <strong>组织密钥用于「按工作区自动建分区」的客户端（如 DSH 插件）。</strong>
            它可访问并创建本组织任意分区，权限高，请妥善保管并设置较短有效期与 IP 白名单；
            若客户端需要自动建分区，请勾选「管理（admin）」作用域。
          </div>
          <div className="tiny dim">
            完整密钥仅在创建时显示一次；组织密钥按组织统一管理，不占用项目密钥列表。此区块仅组织所有者可见。
          </div>
        </div>
      </Callout>

      {!hasPartition ? (
        <Callout tone="amber" icon="alert">
          <div className="vstack gap-8">
            <span>组织下还没有分区：组织密钥需要一个锚点分区（缺省取组织最早创建的分区）。请先创建至少一个项目 / 分区。</span>
            <div>
              <Button size="sm" variant="outline" icon="folder" onClick={() => navigate('/projects')}>
                前往创建分区
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      {error && !data ? (
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      ) : (
        <>
          {error ? (
            <Callout tone="red" icon="alert">
              刷新组织密钥列表失败：{error}
            </Callout>
          ) : null}
          <Card>
            <div className="toolbar" style={{ padding: '16px 20px' }}>
              <div className="toolbar-left">
                <span className="section-title">组织密钥</span>
                <Badge tone="slate" size="sm">
                  共 {keys.length} 个
                </Badge>
                <Badge tone={activeCount > 0 ? 'green' : 'slate'} size="sm">
                  生效 {activeCount} 个
                </Badge>
                {expiringCount > 0 ? <Badge tone="amber" size="sm">即将过期 {expiringCount} 个</Badge> : null}
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
                <Button size="sm" variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                  创建组织密钥
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
                    title="还没有组织密钥"
                    description="如果使用 DSH 插件等客户端按工作区自动建分区，请创建一把组织密钥；它可访问本组织任意分区。"
                    action={
                      <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                        创建第一个组织密钥
                      </Button>
                    }
                  />
                }
              />
            </TableScroller>
          </Card>
        </>
      )}

      <OrgKeyCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(key) => {
          setCreateOpen(false);
          setCreated(key);
          void refresh();
        }}
      />

      <KeySecretModal created={created} kind="org" onClose={closeSecret} />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          void confirmRevoke();
        }}
        loading={revoking}
        title="吊销组织密钥"
        description={
          revokeTarget
            ? `确定吊销「${revokeTarget.name}」吗？所有使用该组织密钥的客户端（如 DSH 插件）会立即失去对本组织分区的访问权限，且此操作无法撤销。`
            : undefined
        }
        confirmLabel="确认吊销"
      />
    </>
  );
}
