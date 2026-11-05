import { useEffect, useMemo, useState } from 'react';
import type { OrgUser, Role } from '@shared';
import { ROLES } from '@shared';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHead,
  SearchInput,
  Select,
  Stat,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api, ApiError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { ROLE_LABEL, toneForRole } from '@lib/tone.ts';
import { projectTone } from '../components/shell/util.ts';
import { TableScroller } from '../components/project-ops/common.tsx';

type StatusFilter = 'all' | 'active' | 'disabled';

interface IssuedPassword {
  member: OrgUser;
  password: string;
  generated: boolean;
  mode: 'created' | 'reset';
}

/** 组织账号的密码策略：至少 10 位，且同时包含字母与数字。 */
function passwordPolicyError(value: string): string | null {
  if (value.length < 10) return '密码至少需要 10 位';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '密码需同时包含字母与数字';
  return null;
}

function MemberMetric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

export function TeamPage() {
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'admin' || user?.role === 'owner';
  const canGovern = user?.role === 'owner';

  const [forbidden, setForbidden] = useState(false);
  const { data, loading, error, refresh } = useAsync(async () => {
    try {
      const list = await api.org.users.list();
      setForbidden(false);
      return list;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
      throw cause;
    }
  }, []);

  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<OrgUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<OrgUser | null>(null);
  const [resetTarget, setResetTarget] = useState<OrgUser | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [resetSaving, setResetSaving] = useState(false);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);

  const members = data ?? [];
  const ready = Boolean(data);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return members.filter((member) => {
      if (roleFilter !== 'all' && member.role !== roleFilter) return false;
      if (statusFilter !== 'all' && member.status !== statusFilter) return false;
      if (!keyword) return true;
      return `${member.name} ${member.email} ${member.title ?? ''}`.toLowerCase().includes(keyword);
    });
  }, [members, query, roleFilter, statusFilter]);

  const activeCount = members.filter((member) => member.status === 'active').length;
  const disabledCount = members.filter((member) => member.status === 'disabled').length;
  const adminCount = members.filter((member) => member.role === 'admin' || member.role === 'owner').length;
  const ownerCount = members.filter((member) => member.role === 'owner').length;
  const activePct = members.length > 0 ? Math.round((activeCount / members.length) * 100) : 0;
  const statValue = (value: string) => (ready ? value : '—');

  const confirmStatus = async () => {
    if (!statusTarget || statusSaving) return;
    const next = statusTarget.status === 'active' ? 'disabled' : 'active';
    setStatusSaving(true);
    try {
      await api.org.users.update(statusTarget.id, { status: next });
      toast.success(
        next === 'disabled' ? `已禁用「${statusTarget.name}」` : `已启用「${statusTarget.name}」`,
      );
      setStatusTarget(null);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '更新成员状态失败，请稍后重试。');
    } finally {
      setStatusSaving(false);
    }
  };

  const confirmReset = async () => {
    if (!resetTarget || resetSaving) return;
    setResetSaving(true);
    try {
      const result = await api.org.users.resetPassword(resetTarget.id);
      toast.success(`已为「${resetTarget.name}」生成临时密码`);
      setIssued({
        member: resetTarget,
        password: result.temporaryPassword,
        generated: true,
        mode: 'reset',
      });
      setResetTarget(null);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '重置密码失败，请稍后重试。');
    } finally {
      setResetSaving(false);
    }
  };

  const clearFilters = () => {
    setQuery('');
    setRoleFilter('all');
    setStatusFilter('all');
  };

  const columns: Column<OrgUser>[] = [
    {
      key: 'member',
      header: '成员',
      width: 260,
      render: (member) => (
        <div className="hstack gap-10">
          <Avatar name={member.name} tone={projectTone(member.id)} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="hstack gap-6">
              <span className="strong truncate" title={member.name}>{member.name}</span>
              {member.id === user?.id ? (
                <Badge tone="violet" size="sm">我</Badge>
              ) : null}
            </div>
            <div className="tiny dim truncate" title={member.email}>{member.email}</div>
            {member.title ? (
              <div className="tiny dim truncate" title={member.title}>{member.title}</div>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      width: 96,
      render: (member) => (
        <Badge tone={toneForRole(member.role)} size="sm">
          {ROLE_LABEL[member.role]}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 96,
      render: (member) =>
        member.status === 'active' ? (
          <Badge tone="green" size="sm" dot>生效</Badge>
        ) : (
          <Badge tone="slate" size="sm" dot>已禁用</Badge>
        ),
    },
    {
      key: 'projectCount',
      header: '参与项目',
      width: 96,
      align: 'right',
      render: (member) => (
        <span className="mono small" title={`参与 ${member.projectCount} 个项目`}>
          {fmtInt(member.projectCount)}
        </span>
      ),
    },
    {
      key: 'activeSessions',
      header: '活跃会话',
      width: 96,
      align: 'right',
      render: (member) =>
        member.activeSessions > 0 ? (
          <span className="hstack gap-6" style={{ justifyContent: 'flex-end' }}>
            <span className="dot tone-green" aria-hidden="true" />
            <span className="mono small">{fmtInt(member.activeSessions)}</span>
          </span>
        ) : (
          <span className="tiny dim">0</span>
        ),
    },
    {
      key: 'lastLoginAt',
      header: '最近登录',
      width: 124,
      render: (member) =>
        member.lastLoginAt ? (
          <span className="tiny muted nowrap" title={fmtFullDateTime(member.lastLoginAt)}>
            {fmtRelative(member.lastLoginAt)}
          </span>
        ) : member.lastSeenAt ? (
          <span className="tiny dim nowrap" title={fmtFullDateTime(member.lastSeenAt)}>
            浏览 {fmtRelative(member.lastSeenAt)}
          </span>
        ) : (
          <span className="tiny dim">从未登录</span>
        ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 288,
      align: 'right',
      render: (member) => {
        if (!canManage) return <span className="tiny dim">只读</span>;
        if (member.id === user?.id) return <span className="tiny dim">当前账号</span>;
        const disabled = member.status === 'disabled';
        const ownerPasswordLocked = member.role === 'owner' && !canGovern;
        return (
          <div className="hstack gap-4" style={{ justifyContent: 'flex-end' }}>
            <Button
              size="sm"
              variant="ghost"
              icon="pencil"
              disabled={!canGovern}
              title={canGovern ? '修改组织角色' : '仅组织所有者可调整成员角色'}
              onClick={() => setRoleTarget(member)}
            >
              角色
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={disabled ? 'checkCircle' : 'lock'}
              disabled={!canGovern}
              title={
                !canGovern
                  ? '仅组织所有者可启用或禁用账号'
                  : disabled
                    ? '恢复该成员登录权限'
                    : '禁止该成员登录控制台'
              }
              onClick={() => setStatusTarget(member)}
            >
              {disabled ? '启用' : '禁用'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="key"
              disabled={ownerPasswordLocked}
              title={ownerPasswordLocked ? '仅组织所有者可重置所有者密码' : '生成一次性临时密码'}
              onClick={() => setResetTarget(member)}
            >
              重置密码
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="组织"
        title="组织成员"
        desc="组织级账号、角色与登录状态；项目内授权仍在各项目「设置」中维护。"
        actions={
          <>
            <Button icon="refresh" loading={loading} onClick={() => void refresh()}>
              刷新
            </Button>
            {canManage ? (
              <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                新建成员
              </Button>
            ) : null}
          </>
        }
      />

      {forbidden ? (
        <Callout tone="amber" icon="lock">
          <strong>需要管理员权限。</strong>
          组织成员名录与管理操作仅对组织管理员与所有者开放
          {user ? `，当前账号角色为「${ROLE_LABEL[user.role]}」` : ''}
          。如需管理成员，请联系组织管理员。
        </Callout>
      ) : (
        <>
          <div className="kpi-grid">
            <Stat
              label="成员数"
              value={statValue(fmtInt(members.length))}
              unit="人"
              icon="users"
              tone="violet"
              hint={`活跃 ${fmtInt(activeCount)} · 禁用 ${fmtInt(disabledCount)}`}
            />
            <Stat
              label="活跃数"
              value={statValue(fmtInt(activeCount))}
              unit="人"
              icon="checkCircle"
              tone="green"
              hint={members.length > 0 ? `占成员总数 ${activePct}%` : '暂无成员数据'}
            />
            <Stat
              label="管理员数"
              value={statValue(fmtInt(adminCount))}
              unit="人"
              icon="shield"
              tone="cyan"
              hint={`含所有者 ${fmtInt(ownerCount)} 位`}
            />
            <Stat
              label="禁用数"
              value={statValue(fmtInt(disabledCount))}
              unit="人"
              icon="lock"
              tone="amber"
              hint="禁用后无法登录控制台"
            />
          </div>

          <Callout tone="cyan" icon="shield">
            成员权限按项目维度授予，可在项目「设置」中调整；本页调整的是组织级角色与账号状态。
          </Callout>

          {!canManage ? (
            <Callout tone="slate" icon="info">
              你当前以「{user ? ROLE_LABEL[user.role] : '成员'}」身份浏览，仅可查看成员名录。
              新建成员、调整角色、禁用账号与重置密码需要管理员权限。
            </Callout>
          ) : !canGovern ? (
            <Callout tone="slate" icon="info">
              当前账号为管理员：可新建成员与重置密码；调整成员角色、启用或禁用账号仅组织所有者可执行。
            </Callout>
          ) : null}

          {error && data ? (
            <Callout tone="amber" icon="alert">
              刷新成员列表失败，当前展示上次成功获取的数据：{error}
            </Callout>
          ) : null}

          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名、邮箱或职位…" />
              <Select
                aria-label="角色筛选"
                options={[
                  { value: 'all', label: '全部角色' },
                  ...ROLES.map((role) => ({ value: role.value, label: role.label })),
                ]}
                value={roleFilter}
                style={{ width: 146 }}
                onChange={(event) => setRoleFilter(event.target.value as Role | 'all')}
              />
              <Select
                aria-label="状态筛选"
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'active', label: '生效' },
                  { value: 'disabled', label: '已禁用' },
                ]}
                value={statusFilter}
                style={{ width: 132 }}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              />
            </div>
            <div className="toolbar-right">
              <span className="tiny dim">共 {fmtInt(filtered.length)} 位成员</span>
            </div>
          </div>

          <Card>
            {error && !data ? (
              <ErrorState message={error} onRetry={() => void refresh()} />
            ) : (
              <TableScroller minWidth={members.length > 0 ? 1160 : undefined}>
                <Table
                  columns={columns}
                  rows={filtered}
                  rowKey={(member) => member.id}
                  loading={loading && !data}
                  empty={
                    members.length === 0 ? (
                      <EmptyState
                        icon="users"
                        title="还没有组织成员"
                        description={
                          canManage
                            ? '创建第一位成员后，可为其授予组织角色并分配项目授权。'
                            : '组织内暂无其他账号，请联系管理员创建成员。'
                        }
                        action={
                          canManage ? (
                            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                              新建成员
                            </Button>
                          ) : undefined
                        }
                      />
                    ) : (
                      <EmptyState
                        compact
                        icon="search"
                        title="没有匹配的成员"
                        description="调整搜索关键词、角色或状态筛选后再试。"
                        action={
                          <Button size="sm" icon="refresh" onClick={clearFilters}>
                            清除筛选
                          </Button>
                        }
                      />
                    )
                  }
                />
              </TableScroller>
            )}
          </Card>
        </>
      )}

      <CreateMemberModal
        open={createOpen}
        canGrantAdmin={canGovern}
        onClose={() => setCreateOpen(false)}
        onCreated={(payload) => {
          setCreateOpen(false);
          setIssued(payload);
          void refresh();
        }}
      />

      <MemberRoleModal
        member={roleTarget}
        onClose={() => setRoleTarget(null)}
        onUpdated={() => {
          void refresh();
        }}
      />

      <ConfirmDialog
        open={Boolean(statusTarget)}
        onClose={() => setStatusTarget(null)}
        onConfirm={() => void confirmStatus()}
        loading={statusSaving}
        tone={statusTarget?.status === 'active' ? 'red' : 'green'}
        title={statusTarget?.status === 'active' ? '禁用成员' : '启用成员'}
        description={
          statusTarget
            ? statusTarget.status === 'active'
              ? `确定禁用「${statusTarget.name}」吗？该账号将立即无法登录控制台，现有会话会在下次请求时失效。`
              : `启用「${statusTarget.name}」后，该账号可重新登录控制台并保有原有项目授权。`
            : undefined
        }
        confirmLabel={statusTarget?.status === 'active' ? '确认禁用' : '确认启用'}
      />

      <ConfirmDialog
        open={Boolean(resetTarget)}
        onClose={() => setResetTarget(null)}
        onConfirm={() => void confirmReset()}
        loading={resetSaving}
        tone="amber"
        title="重置成员密码"
        confirmLabel="生成临时密码"
        description={
          resetTarget
            ? `将为「${resetTarget.name}」生成一次性临时密码，其现有会话会被立即注销。请通过安全渠道把新密码转交本人。`
            : undefined
        }
      />

      <OneTimePasswordModal data={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function CreateMemberModal({
  open,
  canGrantAdmin,
  onClose,
  onCreated,
}: {
  open: boolean;
  canGrantAdmin: boolean;
  onClose: () => void;
  onCreated: (payload: IssuedPassword) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setName('');
    setRole('developer');
    setTitle('');
    setPassword('');
    setTouched(false);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const emailError = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : '请输入有效的工作邮箱';
  const nameError = name.trim() ? null : '请输入成员姓名';
  const passwordError = password.trim() ? passwordPolicyError(password) : null;
  const valid = !emailError && !nameError && !passwordError;
  const roleOptions = canGrantAdmin
    ? ROLES
    : ROLES.filter((item) => item.value === 'developer' || item.value === 'viewer');
  const roleDesc = roleOptions.find((item) => item.value === role)?.desc;

  const submit = async () => {
    setTouched(true);
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.org.users.create({
        email: email.trim(),
        name: name.trim(),
        role,
        title: title.trim() || undefined,
        password: password.trim() || undefined,
      });
      onCreated({
        member: result.user,
        password: result.temporaryPassword,
        generated: !password.trim(),
        mode: 'created',
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建成员失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建组织成员"
      description="成员创建后会立即获得组织级角色；项目授权需在对应项目中单独添加。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" loading={submitting} onClick={() => void submit()}>
            创建成员
          </Button>
        </>
      }
    >
      <Field label="工作邮箱" htmlFor="member-email" required error={touched && emailError ? emailError : undefined}>
        <Input
          id="member-email"
          type="email"
          icon="mail"
          value={email}
          placeholder="name@company.com"
          autoComplete="off"
          autoFocus
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="姓名" htmlFor="member-name" required error={touched && nameError ? nameError : undefined}>
          <Input
            id="member-name"
            value={name}
            placeholder="例如：林薇"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="组织角色"
          htmlFor="member-role"
          hint={
            canGrantAdmin
              ? roleDesc
              : '管理员仅可创建开发者或只读账号；管理员与所有者需由组织所有者创建。'
          }
        >
          <Select
            id="member-role"
            options={roleOptions.map((item) => ({ value: item.value, label: item.label }))}
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          />
        </Field>
      </div>

      <Field label="职位" htmlFor="member-title" hint="可选，用于成员列表展示。">
        <Input
          id="member-title"
          value={title}
          placeholder="例如：记忆平台工程师"
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <Field
        label="初始密码"
        htmlFor="member-password"
        error={touched && passwordError ? passwordError : undefined}
        hint="留空则由系统生成临时密码；填写时至少 10 位并同时包含字母与数字。"
      >
        <Input
          id="member-password"
          type="password"
          value={password}
          placeholder="留空自动生成"
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      {error ? (
        <Callout tone="red" icon="alert">{error}</Callout>
      ) : null}
    </Modal>
  );
}

function MemberRoleModal({
  member,
  onClose,
  onUpdated,
}: {
  member: OrgUser | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const toast = useToast();
  const [role, setRole] = useState<Role>('developer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    setRole(member.role);
    setError(null);
    setSubmitting(false);
  }, [member]);

  if (!member) return null;

  const downgradingOwner = member.role === 'owner' && role !== 'owner';
  const promotingOwner = role === 'owner' && member.role !== 'owner';
  const roleDesc = ROLES.find((item) => item.value === role)?.desc;

  const submit = async () => {
    if (submitting) return;
    if (role === member.role) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.org.users.update(member.id, { role });
      toast.success(`已将「${member.name}」的角色调整为${ROLE_LABEL[role]}`);
      onClose();
      onUpdated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '调整角色失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="修改成员角色"
      description={`${member.name} · ${member.email}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={() => void submit()}>
            保存角色
          </Button>
        </>
      }
    >
      <Field label="组织角色" htmlFor="member-role-edit" hint={roleDesc}>
        <Select
          id="member-role-edit"
          options={ROLES.map((item) => ({ value: item.value, label: item.label }))}
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        />
      </Field>

      {downgradingOwner ? (
        <Callout tone="amber" icon="alert">
          所有者降级会移交组织最高权限。服务端会校验执行者身份，若被拒绝请由所有者本人操作。
        </Callout>
      ) : null}

      {promotingOwner ? (
        <Callout tone="amber" icon="shield">
          授予所有者角色意味着移交组织最高权限，请确认对方身份与授权范围。
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="red" icon="alert">{error}</Callout>
      ) : null}
    </Modal>
  );
}

function OneTimePasswordModal({ data, onClose }: { data: IssuedPassword | null; onClose: () => void }) {
  if (!data) return null;

  const title = data.mode === 'reset' ? '密码已重置' : '成员已创建';
  const intro = data.generated ? '系统已生成临时密码。' : '已使用你设置的初始密码。';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description="密码仅显示一次，关闭后无法再次查看。"
      footer={
        <Button variant="primary" icon="check" onClick={onClose}>
          我已保存，关闭
        </Button>
      }
    >
      <Callout tone="amber" icon="alert">
        <strong>仅显示一次，请转交本人。</strong>
        {intro}建议通过安全渠道发送，并提醒成员首次登录后立即修改密码。
      </Callout>

      <div className="metric-grid">
        <MemberMetric label="成员" value={data.member.name} />
        <MemberMetric label="邮箱" value={data.member.email} mono />
        <MemberMetric label="角色" value={ROLE_LABEL[data.member.role]} />
        <MemberMetric label="账号状态" value={data.member.status === 'disabled' ? '已禁用' : '生效'} />
      </div>

      <div className="code-block">
        <div className="code-head">
          <span className="mono">初始密码</span>
          <CopyButton value={data.password} label="复制密码" />
        </div>
        <pre className="code-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {data.password}
        </pre>
      </div>

      <div className="tiny dim">关闭窗口后将无法再次查看该密码；如遗失请重新重置。</div>
    </Modal>
  );
}
