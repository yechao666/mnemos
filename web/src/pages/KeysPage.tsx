import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ApiKey, ApiKeyWithSecret } from '@lib/types.ts';
import { ROLE_RANK } from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  PageHead,
  SectionHead,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { fmtDateTime, fmtRelative, maskKey } from '@lib/format.ts';
import { KeyCreateModal, KeySecretModal, KEY_SCOPE_OPTIONS } from '../components/keys/KeyModals.tsx';

const SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  KEY_SCOPE_OPTIONS.map((scope) => [scope.value, scope.label]),
);

function keyStatus(key: ApiKey): { label: string; tone: 'green' | 'slate' | 'red' | 'amber' } {
  if (key.revokedAt) return { label: '已吊销', tone: 'red' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) return { label: '已过期', tone: 'slate' };
  if (key.lastUsedAt) return { label: '使用中', tone: 'green' };
  return { label: '未使用', tone: 'amber' };
}

/** 密钥：分区密钥 + 组织密钥（组织密钥仅 owner 可见）。 */
export function KeysPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition } = usePartitionContext();
  const { user } = useAuth();
  const toast = useToast();
  const isOwner = user?.role === 'owner';
  const canManage = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);

  const partitionKeys = useAsync(() => api.partitions.keys.list(partitionId), [partitionId], Boolean(partitionId));
  const orgKeys = useAsync(() => api.org.keys.list(), [], isOwner);

  const [createKind, setCreateKind] = useState<'partition' | 'org' | null>(null);
  const [secretKey, setSecretKey] = useState<ApiKeyWithSecret | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ key: ApiKey; kind: 'partition' | 'org' } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (kind: 'partition' | 'org', input: Parameters<typeof api.partitions.keys.create>[1]) => {
    const created =
      kind === 'org'
        ? await api.org.keys.create({ ...input, partitionId })
        : await api.partitions.keys.create(partitionId, input);
    setSecretKey(created);
    toast.success('密钥已创建');
    if (kind === 'org') await orgKeys.refresh();
    else await partitionKeys.refresh();
  };

  const rotate = async (key: ApiKey) => {
    setBusy(true);
    try {
      const rotated = await api.partitions.keys.rotate(partitionId, key.id);
      setSecretKey(rotated);
      toast.success('密钥已轮换，旧密钥按 grace 策略失效');
      await partitionKeys.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '轮换失败');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      if (revokeTarget.kind === 'org') {
        await api.org.keys.revoke(revokeTarget.key.id);
        await orgKeys.refresh();
      } else {
        await api.partitions.keys.revoke(partitionId, revokeTarget.key.id);
        await partitionKeys.refresh();
      }
      toast.success(`密钥「${revokeTarget.key.name}」已吊销`);
      setRevokeTarget(null);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '吊销失败');
    } finally {
      setBusy(false);
    }
  };

  const columns = (kind: 'partition' | 'org'): Column<ApiKey>[] => [
    {
      key: 'name',
      header: '名称',
      render: (key) => (
        <div style={{ minWidth: 0 }}>
          <div className="strong truncate">{key.name}</div>
          <div className="tiny dim mono truncate">{maskKey(key.prefix)}</div>
        </div>
      ),
    },
    {
      key: 'scopes',
      header: '作用域',
      width: 210,
      render: (key) => (
        <span className="chip-row">
          {key.scopes.length === 0 ? <span className="tiny dim">—</span> : null}
          {key.scopes.map((scope) => (
            <Badge key={scope} tone="violet" size="sm">{SCOPE_LABEL[scope] ?? scope}</Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'rate',
      header: '限流',
      width: 92,
      align: 'right',
      render: (key) => <span className="tiny mono">{key.rateLimitPerMin}/min</span>,
    },
    {
      key: 'lastUsed',
      header: '最近使用',
      width: 120,
      render: (key) => (
        <span className="tiny dim" title={key.lastUsedAt ? fmtDateTime(key.lastUsedAt) : undefined}>
          {key.lastUsedAt ? fmtRelative(key.lastUsedAt) : '从未'}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 90,
      render: (key) => {
        const meta = keyStatus(key);
        return <Badge tone={meta.tone} size="sm" dot>{meta.label}</Badge>;
      },
    },
    {
      key: 'actions',
      header: '',
      width: 92,
      align: 'right',
      render: (key) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
          {kind === 'partition' ? (
            <IconButton icon="refresh" label="轮换密钥" size="sm" disabled={busy || Boolean(key.revokedAt)} onClick={() => void rotate(key)} />
          ) : null}
          <IconButton
            icon="trash"
            label="吊销密钥"
            size="sm"
            disabled={busy || Boolean(key.revokedAt) || !canManage}
            onClick={() => setRevokeTarget({ key, kind })}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="密钥"
        title="密钥"
        desc={`分区「${partition?.name ?? partitionId}」的 API 密钥与组织级密钥。密钥明文只在创建/轮换时返回一次。`}
        actions={
          canManage ? (
            <>
              <Button icon="key" onClick={() => setCreateKind('partition')}>新建分区密钥</Button>
              {isOwner ? (
                <Button variant="secondary" icon="shield" onClick={() => setCreateKind('org')}>
                  新建组织密钥
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <Card>
        <div style={{ padding: '14px 16px 0' }}>
          <SectionHead
            title="分区密钥"
            desc="只能访问当前分区；按作用域最小授权。"
            actions={
              <IconButton icon="refresh" label="刷新分区密钥" size="sm" disabled={partitionKeys.loading} onClick={() => void partitionKeys.refresh()} />
            }
          />
        </div>
        {partitionKeys.error && !partitionKeys.data ? (
          <div style={{ padding: 16 }}>
            <ErrorState message={partitionKeys.error} onRetry={() => void partitionKeys.refresh()} />
          </div>
        ) : (
          <Table
            columns={columns('partition')}
            rows={partitionKeys.data ?? []}
            rowKey={(key) => key.id}
            loading={partitionKeys.loading && !partitionKeys.data}
            empty={
              <EmptyState
                icon="key"
                title="还没有分区密钥"
                description="创建一把密钥后即可用 Authorization: Bearer <secret> 调用 v1 API。"
                action={canManage ? <Button size="sm" variant="primary" icon="plus" onClick={() => setCreateKind('partition')}>新建分区密钥</Button> : undefined}
                compact
              />
            }
          />
        )}
      </Card>

      {isOwner ? (
        <Card>
          <div style={{ padding: '14px 16px 0' }}>
            <SectionHead
              title="组织密钥"
              desc="可访问/创建本组织任意分区（DSH 插件按工作区建分区用）；仅 owner 可管理。"
              actions={
                <IconButton icon="refresh" label="刷新组织密钥" size="sm" disabled={orgKeys.loading} onClick={() => void orgKeys.refresh()} />
              }
            />
          </div>
          {orgKeys.error && !orgKeys.data ? (
            <div style={{ padding: 16 }}>
              <ErrorState message={orgKeys.error} onRetry={() => void orgKeys.refresh()} />
            </div>
          ) : (
            <Table
              columns={columns('org')}
              rows={orgKeys.data ?? []}
              rowKey={(key) => key.id}
              loading={orgKeys.loading && !orgKeys.data}
              empty={
                <EmptyState
                  icon="shield"
                  title="还没有组织密钥"
                  description="组织密钥用于跨分区自动化（例如 DSH 插件按工作区建分区）。"
                  action={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreateKind('org')}>新建组织密钥</Button>}
                  compact
                />
              }
            />
          )}
        </Card>
      ) : (
        <Callout tone="slate" icon="info">
          组织密钥仅组织所有者（owner）可查看和管理；分区密钥由管理员维护。
        </Callout>
      )}

      <KeyCreateModal
        open={createKind !== null}
        onClose={() => setCreateKind(null)}
        kind={createKind ?? 'partition'}
        onCreate={(input) => create(createKind ?? 'partition', input)}
      />
      <KeySecretModal open={secretKey !== null} onClose={() => setSecretKey(null)} keyInfo={secretKey} />
      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void revoke()}
        title="吊销密钥"
        description={revokeTarget ? `吊销「${revokeTarget.key.name}」后，使用该密钥的调用会立即失败。` : undefined}
        confirmLabel="吊销"
        loading={busy}
      />
    </div>
  );
}
