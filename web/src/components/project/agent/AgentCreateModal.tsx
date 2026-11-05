import { useEffect, useState } from 'react';
import type { Agent, AgentInput, AgentStatus } from '@shared';
import {
  Button,
  Callout,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Textarea,
} from '@ui';
import { api, ApiError } from '@lib/api.ts';
import { AGENT_STATUS_OPTIONS } from './shared.tsx';

const MAX_CAPABILITIES = 12;

function parseCapabilities(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCapabilities(current: string[], raw: string): string[] {
  const merged = [...current];
  for (const capability of parseCapabilities(raw)) {
    if (!merged.includes(capability) && merged.length < MAX_CAPABILITIES) merged.push(capability);
  }
  return merged;
}

/** 新建 Agent：注册身份、模型与能力，供任务指派与记忆归因使用。 */
export function AgentCreateModal({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (agent: Agent) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState('');
  const [status, setStatus] = useState<AgentStatus>('active');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setRole('');
    setModel('');
    setDescription('');
    setCapabilities([]);
    setCapabilityInput('');
    setStatus('active');
    setNameError(null);
    setError(null);
    setSaving(false);
  }, [open]);

  const addCapability = () => {
    if (!capabilityInput.trim()) return;
    setCapabilities((prev) => mergeCapabilities(prev, capabilityInput));
    setCapabilityInput('');
  };

  const removeCapability = (capability: string) => {
    setCapabilities((prev) => prev.filter((item) => item !== capability));
  };

  const submit = async () => {
    if (!name.trim()) {
      setNameError('请填写 Agent 名称。');
      return;
    }
    setSaving(true);
    setError(null);
    setNameError(null);

    const input: AgentInput = {
      name: name.trim(),
      status,
      capabilities: mergeCapabilities(capabilities, capabilityInput),
    };
    if (role.trim()) input.role = role.trim();
    if (model.trim()) input.model = model.trim();
    if (description.trim()) input.description = description.trim();
    if (!input.capabilities?.length) delete input.capabilities;

    try {
      const created = await api.agents.create(projectId, input);
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建 Agent 失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建 Agent"
      description="注册后即可在任务中指派 owner；通过 API 首次写入记忆时也会自动出现在注册表。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" icon="plus" loading={saving} onClick={() => void submit()}>
            创建 Agent
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <div className="grid grid-2">
          <Field label="名称" required error={nameError} htmlFor="agent-name">
            <Input
              id="agent-name"
              value={name}
              autoFocus
              placeholder="例如：后端开发 Agent"
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
            />
          </Field>
          <Field label="角色" htmlFor="agent-role" hint="例如：backend / reviewer / oncall">
            <Input
              id="agent-role"
              value={role}
              placeholder="backend"
              onChange={(event) => setRole(event.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="模型" htmlFor="agent-model" hint="用于人类识别，不参与路由。">
            <Input
              id="agent-model"
              value={model}
              placeholder="例如：claude-sonnet-4.5"
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <Field label="状态" htmlFor="agent-status">
            <Select
              id="agent-status"
              options={AGENT_STATUS_OPTIONS}
              value={status}
              onChange={(event) => setStatus(event.target.value as AgentStatus)}
            />
          </Field>
        </div>

        <Field label="描述" hint="职责范围、能力边界与协作方式，会展示在注册表卡片上。">
          <Textarea
            rows={3}
            value={description}
            placeholder="例如：负责订单服务的接口开发与缺陷修复，遵循项目内的分层与测试门禁。"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field
          label="能力"
          hint={`输入后按回车或逗号添加，最多 ${MAX_CAPABILITIES} 项；例如 code-review、sql、oncall。`}
        >
          <Input
            value={capabilityInput}
            placeholder="输入能力标签后回车"
            onChange={(event) => setCapabilityInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault();
                addCapability();
              }
            }}
            onBlur={addCapability}
          />
          <div className="chip-row mt-8">
            {capabilities.length ? (
              capabilities.map((capability) => (
                <button
                  key={capability}
                  type="button"
                  className="chip chip-clickable"
                  title={`移除能力 ${capability}`}
                  onClick={() => removeCapability(capability)}
                >
                  {capability}
                  <Icon name="x" size={11} />
                </button>
              ))
            ) : (
              <span className="tiny dim">尚未添加能力标签。</span>
            )}
          </div>
        </Field>

        {error ? (
          <Callout tone="red" icon="alert">
            {error}
          </Callout>
        ) : null}
      </div>
    </Modal>
  );
}
