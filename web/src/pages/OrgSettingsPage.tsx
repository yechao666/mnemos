import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OrgUser, Role } from '@lib/types.ts';
import { ROLE_LABEL, ROLE_RANK } from '@lib/constants.ts';
import { toneForRole } from '@lib/tone.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHead,
  SectionHead,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtRelative } from '@lib/format.ts';

const MANAGED_ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: '管理员' },
  { value: 'developer', label: '开发者' },
  { value: 'viewer', label: '只读' },
];

/** 组织设置：组织资料 + 控制台账号（登录用，不是「人」）。 */
export function OrgSettingsPage() {
  const navigate = useNavigate();
  const { user, org, partitions, refresh } = useAuth();
  const toast = useToast();
  const isAdmin = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);

  const users = useAsync(() => api.org.users.list(), [], isAdmin);

  const [createOpen, setCreateOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<OrgUser | null>(null);
  const [resetting, setResetting] = useState(false);

  const resetPassword = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      const result = await api.org.users.resetPassword(resetTarget.id);
      setTempPassword({ email: resetTarget.email, password: result.temporaryPassword });
      setResetTarget(null);
      toast.success('已生成临时密码');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '重置密码失败');
    } finally {
      setResetting(false);
    }
  };

  const columns: Column<OrgUser>[] = [
    {
      key: 'name',
      header: '账号',
      render: (row) => (
        <div className="hstack gap-10" style={{ minWidth: 0 }}>
          <Avatar name={row.name} tone={toneForRole(row.role)} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="strong truncate">{row.name}</div>
            <div className="tiny dim truncate">{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      width: 110,
      render: (row) => <Badge tone={toneForRole(row.role)} size="sm">{ROLE_LABEL[row.role]}</Badge>,
    },
    {
      key: 'status',
      header: '状态',
      width: 96,
      render: (row) => (
        <Badge tone={row.status === 'active' ? 'green' : 'slate'} size="sm" dot>
          {row.status === 'active' ? '启用' : '禁用'}
        </Badge>
      ),
    },
    {
      key: 'lastSeen',
      header: '最近登录',
      width: 130,
      render: (row) => (
        <span className="tiny dim" title={row.lastSeenAt ? fmtFullDateTime(row.lastSeenAt) : undefined}>
          {row.lastSeenAt ? fmtRelative(row.lastSeenAt) : '从未'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 96,
      align: 'right',
      render: (row) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon="refresh" label="重置密码" size="sm" disabled={!isAdmin} onClick={() => setResetTarget(row)} />
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="组织"
        title="组织设置"
        desc="组织级资料与登录账号。控制台账号只用于登录与权限；记忆的「人」是数据主体，在分区内管理。"
        actions={
          isAdmin ? (
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              新建控制台账号
            </Button>
          ) : null
        }
      />

      <Card pad>
        <SectionHead
          title="组织资料"
          desc="组织由部署初始化创建；分区、密钥与账号都归属当前组织。"
          actions={<Badge tone="violet" size="sm">{org?.plan ?? '—'}</Badge>}
        />
        <div className="grid grid-4 mt-12">
          <div>
            <div className="tiny dim">组织名称</div>
            <div className="strong mt-4">{org?.name ?? '—'}</div>
          </div>
          <div>
            <div className="tiny dim">slug</div>
            <div className="mono small mt-4">{org?.slug ?? '—'}</div>
          </div>
          <div>
            <div className="tiny dim">分区</div>
            <div className="strong mt-4">{partitions.length} 个</div>
          </div>
          <div>
            <div className="tiny dim">当前账号</div>
            <div className="strong mt-4">{user ? `${user.name} · ${ROLE_LABEL[user.role]}` : '—'}</div>
          </div>
        </div>
        <div className="hstack gap-8 wrap mt-16">
          <Button size="sm" icon="layers" onClick={() => navigate('/partitions')}>分区列表</Button>
          <Button
            size="sm"
            icon="key"
            onClick={() => navigate(partitions[0] ? `/partitions/${partitions[0].id}/keys` : '/partitions')}
          >
            组织密钥
          </Button>
          <Button size="sm" icon="shield" onClick={() => navigate('/org/privacy')}>
            全局隐私规则
          </Button>
          <span className="tiny dim">组织密钥在任一分区的「密钥」页管理（仅 owner）；隐私规则可在「隐私规则」页维护。</span>
        </div>
      </Card>

      {isAdmin ? (
        <Card>
          <div style={{ padding: '14px 16px 0' }}>
            <SectionHead
              title="控制台账号"
              desc="登录控制台的组织成员；与记忆数据里的「人」无关。"
              actions={<IconButton icon="refresh" label="刷新账号" size="sm" disabled={users.loading} onClick={() => void users.refresh()} />}
            />
          </div>
          {users.error && !users.data ? (
            <div style={{ padding: 16 }}>
              <ErrorState message={users.error} onRetry={() => void users.refresh()} />
            </div>
          ) : (
            <Table
              columns={columns}
              rows={users.data ?? []}
              rowKey={(row) => row.id}
              loading={users.loading && !users.data}
              empty={<EmptyState icon="users" title="暂无控制台账号" description="创建账号后即可登录控制台。" compact />}
            />
          )}
        </Card>
      ) : (
        <Callout tone="slate" icon="info">
          控制台账号管理需要管理员及以上权限。当前账号为「{user ? ROLE_LABEL[user.role] : '—'}」。
        </Callout>
      )}

      <CreateOrgUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (email, temporaryPassword) => {
          await users.refresh();
          setTempPassword({ email, password: temporaryPassword });
          await refresh();
        }}
      />

      <Modal
        open={tempPassword !== null}
        onClose={() => setTempPassword(null)}
        title="临时密码"
        description="请把临时密码交给该账号本人，并提示登录后修改。密码只显示这一次。"
        footer={<Button variant="ghost" onClick={() => setTempPassword(null)}>关闭</Button>}
      >
        <div className="vstack gap-12">
          <Field label="账号"><Input readOnly value={tempPassword?.email ?? ''} /></Field>
          <Field label="临时密码"><Input readOnly className="mono" value={tempPassword?.password ?? ''} /></Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        onConfirm={() => void resetPassword()}
        title="重置账号密码"
        description={resetTarget ? `将为 ${resetTarget.email} 生成新的临时密码，旧密码立即失效。` : undefined}
        confirmLabel="重置密码"
        loading={resetting}
      />
    </div>
  );
}

function CreateOrgUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (email: string, temporaryPassword: string) => Promise<void>;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setName('');
    setRole('developer');
    setError(null);
  }, [open]);

  const submit = async () => {
    if (submitting) return;
    if (!email.trim() || !name.trim()) {
      setError('请填写姓名与邮箱。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.org.users.create({ email: email.trim(), name: name.trim(), role });
      toast.success('控制台账号已创建');
      onClose();
      await onCreated(result.user.email, result.temporaryPassword);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建控制台账号"
      description="账号用于登录控制台；记忆数据请通过「人（Person）」管理。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" loading={submitting} onClick={() => void submit()}>
            创建账号
          </Button>
        </>
      }
    >
      <div className="vstack gap-12">
        <Field label="姓名" required htmlFor="org-user-name">
          <Input id="org-user-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：周宁" autoFocus />
        </Field>
        <Field label="邮箱" required htmlFor="org-user-email">
          <Input id="org-user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ning.zhou@company.com" />
        </Field>
        <Field label="角色" htmlFor="org-user-role" hint="管理员可管理密钥、账号与设置；开发者可读写记忆；只读仅查看。">
          <Select
            id="org-user-role"
            options={MANAGED_ROLES}
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          />
        </Field>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
      </div>
    </Modal>
  );
}
