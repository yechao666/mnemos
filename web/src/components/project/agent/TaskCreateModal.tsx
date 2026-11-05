import { useEffect, useState } from 'react';
import type { Agent, Task, TaskInput } from '@shared';
import { Button, Callout, Field, Input, Modal, Select, Textarea } from '@ui';
import { api, ApiError } from '@lib/api.ts';

/** 新建任务：把一次跨时间的工作会话登记为可归因、可沉淀的任务。 */
export function TaskCreateModal({
  open,
  onClose,
  projectId,
  agents,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  agents: Agent[];
  onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [branch, setBranch] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setGoal('');
    setOwnerAgentId('');
    setBranch('');
    setTitleError(null);
    setError(null);
    setSaving(false);
  }, [open]);

  const ownerOptions = [
    { value: '', label: '不指定 owner' },
    ...agents.map((agent) => ({
      value: agent.id,
      label: agent.role ? `${agent.name} · ${agent.role}` : agent.name,
    })),
  ];

  const submit = async () => {
    if (!title.trim()) {
      setTitleError('请填写任务标题。');
      return;
    }
    setSaving(true);
    setError(null);
    setTitleError(null);

    const input: TaskInput = { title: title.trim() };
    if (goal.trim()) input.goal = goal.trim();
    if (ownerAgentId) input.ownerAgentId = ownerAgentId;
    if (branch.trim()) input.branch = branch.trim();

    try {
      const created = await api.tasks.create(projectId, input);
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建任务失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建任务"
      description="任务用于归因「谁在什么时间、为什么目标写了哪些记忆」；结束时会自动把结论沉淀为项目共享记忆。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" icon="plus" loading={saving} onClick={() => void submit()}>
            创建任务
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <Field label="标题" required error={titleError} htmlFor="task-title">
          <Input
            id="task-title"
            value={title}
            autoFocus
            placeholder="例如：拆分订单查询服务"
            onChange={(event) => {
              setTitle(event.target.value);
              if (titleError) setTitleError(null);
            }}
          />
        </Field>

        <Field label="目标" hint="写清完成标准与范围，简报与后续 Agent 会读取这段描述。">
          <Textarea
            rows={3}
            value={goal}
            placeholder="例如：把订单查询从单体中拆出，保持接口契约不变，并补齐只读副本路由与压测。"
            onChange={(event) => setGoal(event.target.value)}
          />
        </Field>

        <div className="grid grid-2">
          <Field label="Owner Agent" hint={agents.length ? undefined : '尚未注册 Agent，可暂不指定。'}>
            <Select
              options={ownerOptions}
              value={ownerAgentId}
              onChange={(event) => setOwnerAgentId(event.target.value)}
            />
          </Field>
          <Field label="分支" hint="代码分支或环境标识，便于人类回溯改动。">
            <Input
              value={branch}
              placeholder="例如：feature/order-query-service"
              onChange={(event) => setBranch(event.target.value)}
            />
          </Field>
        </div>

        {error ? (
          <Callout tone="red" icon="alert">
            {error}
          </Callout>
        ) : null}
      </div>
    </Modal>
  );
}
