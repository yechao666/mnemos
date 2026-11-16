import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ProjectMember, Role } from '@shared';
import { ROLES } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDate } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Modal,
  PageHead,
  SearchInput,
  SectionHead,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role.value, label: role.label }));

/** 项目成员：独立页签维护项目成员与角色。 */
export function ProjectMembersPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const toast = useToast();
  const membersAsync = useAsync(() => api.projects.members.list(projectId), [projectId], Boolean(projectId));
  const [addOpen, setAddOpen] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState<Role>('developer');
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const users = useAsync(() => api.org.users.list(), [addOpen], addOpen);
  const members = membersAsync.data ?? [];
  const existing = useMemo(() => new Set(members.map((member) => member.userId)), [members]);
  const availableUsers = useMemo(() => (users.data ?? []).filter((user) => !existing.has(user.id)), [users.data, existing]);

  useEffect(() => {
    if (!addOpen) return;
    setNewUserId('');
    setNewRole('developer');
  }, [addOpen]);

  const addMember = async () => {
    if (!newUserId) return;
    setSaving(true);
    try {
      await api.projects.members.add(projectId, { userId: newUserId, role: newRole });
      toast.success('成员已加入项目');
      setAddOpen(false);
      await membersAsync.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '添加成员失败');
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (member: ProjectMember, role: Role) => {
    try {
      await api.projects.members.update(projectId, member.userId, role);
      toast.success('成员角色已更新');
      await membersAsync.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '更新角色失败');
    }
  };

  const removeMember = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.projects.members.remove(projectId, removeTarget.userId);
      toast.success('成员已移出项目');
      setRemoveTarget(null);
      await membersAsync.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '移除成员失败');
    } finally {
      setRemoving(false);
    }
  };

  const visibleMembers = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return members.filter((member) => (roleFilter === 'all' || member.role === roleFilter)
      && (!query || `${member.name}\n${member.email}`.toLowerCase().includes(query)));
  }, [members, roleFilter, keyword]);

  const columns: Column<ProjectMember>[] = [
    {
      key: 'member',
      header: '成员',
      width: 260,
      sortValue: (member) => member.name,
      render: (member) => (
        <div className="hstack gap-10">
          <Avatar name={member.name} tone={(member.avatarColor as never) ?? 'violet'} />
          <div className="vstack" style={{ gap: 1, minWidth: 0 }}>
            <span className="strong truncate">{member.name}</span>
            <span className="tiny dim truncate">{member.email}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '项目角色',
      width: 160,
      sortValue: (member) => member.role,
      render: (member) => (
        <Select
          value={member.role}
          options={ROLE_OPTIONS}
          aria-label={`修改 ${member.name} 的项目角色`}
          onChange={(event) => void updateRole(member, event.target.value as Role)}
          style={{ minWidth: 130 }}
        />
      ),
    },
    { key: 'joinedAt', header: '加入时间', width: 130, sortValue: (member) => member.joinedAt, render: (member) => <span className="tiny dim">{fmtDate(member.joinedAt)}</span> },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 100,
      sortable: false,
      render: (member) => <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoveTarget(member)}>移除</Button>,
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 协作"
        title="项目成员"
        desc="维护项目成员与角色。成员变更会立即影响项目内的读写、密钥和设置权限。"
        actions={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>添加成员</Button>}
      />
      <Card>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-faint)' }}>
          <SectionHead title={<span className="hstack gap-8"><Badge tone="violet" size="sm" dot>成员 {members.length}</Badge></span>} desc="角色越高，可执行的管理操作越多。" />
        </div>
        <div className="toolbar" style={{ padding: '10px 16px' }}>
          <div className="toolbar-left">
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索姓名或邮箱" />
            <Select
              value={roleFilter}
              options={[{ value: 'all', label: '全部角色' }, ...ROLE_OPTIONS]}
              onChange={(event) => setRoleFilter(event.target.value as 'all' | Role)}
              aria-label="按角色筛选"
              style={{ width: 140 }}
            />
            <span className="tiny dim">共 {visibleMembers.length} 人</span>
          </div>
        </div>
        {membersAsync.error ? <div style={{ padding: 16 }}><Callout tone="red" icon="alert">{membersAsync.error}</Callout></div> : (
          <Table
            columns={columns}
            rows={visibleMembers}
            sortable
            resizable
            rowKey={(member) => member.userId}
            loading={membersAsync.loading && !membersAsync.data}
            empty={<EmptyState icon="users" title="暂无项目成员" description="添加成员后，他们可以按角色访问项目数据。" compact />}
          />
        )}
      </Card>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加项目成员"
        description="从组织成员中选择一位加入本项目。"
        footer={<><Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button><Button variant="primary" loading={saving} disabled={!newUserId} onClick={() => void addMember()}>添加</Button></>}
      >
        <Field label="成员" required>
          {users.loading && !users.data ? <div className="tiny dim">正在加载组织成员…</div> : users.error ? <Callout tone="red" icon="alert">{users.error}</Callout> : (
            <Select value={newUserId} options={[{ value: '', label: '选择组织成员' }, ...availableUsers.map((user) => ({ value: user.id, label: `${user.name} · ${user.email}` }))]} onChange={(event) => setNewUserId(event.target.value)} />
          )}
        </Field>
        <Field label="项目角色" required>
          <Select value={newRole} options={ROLE_OPTIONS} onChange={(event) => setNewRole(event.target.value as Role)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void removeMember()}
        title="移除项目成员"
        description={`确认把「${removeTarget?.name ?? ''}」移出项目？其历史数据会保留。`}
        confirmLabel="移除成员"
        loading={removing}
      />
    </div>
  );
}
