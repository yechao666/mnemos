import { useEffect, useState } from 'react';
import type { MemoryScope } from '@shared';
import {
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { fmtInt } from '@lib/format.ts';
import { SCOPE_WRITE_OPTIONS } from '../person/shared.tsx';

export interface MemoryCreateModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** 默认可见范围（取分区设置 defaultScope） */
  defaultScope?: MemoryScope;
  /** 写入成功后回调（父页面刷新列表与简报） */
  onCreated?: () => void;
}

/**
 * 写入记忆弹窗：一条文本 → 记忆，可指定归属人（external id）与可见范围。
 * 归属人留空即分区共享知识（person_id = NULL）；仅本人 / 仅会话需要额外约束。
 * 写入复用演练场接口，便于后续后端统一扩展 person/scope 字段。
 */
export function MemoryCreateModal({
  open,
  onClose,
  projectId,
  defaultScope = 'partition',
  onCreated,
}: MemoryCreateModalProps) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [personExternalId, setPersonExternalId] = useState('');
  const [scope, setScope] = useState<MemoryScope>(defaultScope);
  const [sessionId, setSessionId] = useState('');
  const [infer, setInfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都回到干净状态，并采用分区当前的默认范围。
  useEffect(() => {
    if (!open) return;
    setText('');
    setPersonExternalId('');
    setScope(defaultScope);
    setSessionId('');
    setInfer(false);
    setError(null);
    setBusy(false);
  }, [open, defaultScope]);

  const person = personExternalId.trim();
  const canSubmit =
    text.trim().length > 0 &&
    !busy &&
    (scope !== 'person' || person.length > 0) &&
    (scope !== 'session' || sessionId.trim().length > 0);

  const submit = async () => {
    if (!projectId || busy) return;
    const content = text.trim();
    if (!content) {
      toast.warning('请填写要写入的记忆内容');
      return;
    }
    if (scope === 'person' && !person) {
      toast.warning('「仅本人」需要填写归属人的 external ID');
      return;
    }
    if (scope === 'session' && !sessionId.trim()) {
      toast.warning('「仅会话」需要填写会话 ID');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.playground.add(projectId, {
        text: content,
        infer,
        scope,
        ...(person ? { personExternalId: person } : {}),
        ...(scope === 'session' ? { sessionId: sessionId.trim() } : {}),
      });
      toast.success(
        `写入完成：${fmtInt(result.results.length)} 条（抽取 ${fmtInt(result.extracted)}，合并 ${fmtInt(
          result.merged,
        )}）`,
      );
      onCreated?.();
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '写入记忆失败';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="写入记忆"
      description="写入一条属于某个人、或整个分区共享的记忆。"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" icon="brain" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            写入
          </Button>
        </>
      }
    >
      <div className="vstack gap-12">
        <Callout tone="violet" icon="info">
          归属人留空即「分区共享知识」（person_id 为空）；填写后这条记忆会归到该人名下。人不存在时后端会在允许的情况下自动建档。
        </Callout>

        <Field label="记忆内容" required>
          <Textarea
            rows={5}
            value={text}
            placeholder="例如：用户偏好靠窗座位，且对花生过敏。"
            onChange={(event) => setText(event.target.value)}
          />
        </Field>

        <div className="grid grid-2">
          <Field label="归属人 external ID" hint="App user_id / Agent id，留空 = 分区共享">
            <Input
              value={personExternalId}
              placeholder="user-123 / agent-a"
              onChange={(event) => setPersonExternalId(event.target.value)}
            />
          </Field>
          <Field label="可见范围" hint={SCOPE_WRITE_OPTIONS.find((item) => item.value === scope)?.label}>
            <Select
              options={SCOPE_WRITE_OPTIONS}
              value={scope}
              aria-label="可见范围"
              onChange={(event) => setScope(event.target.value as MemoryScope)}
            />
          </Field>
        </div>

        {scope === 'session' ? (
          <Field label="会话 ID" required hint="scope=session 时必须提供会话 ID（旧 task_id / run_id）">
            <Input
              value={sessionId}
              placeholder="session_2026_..."
              onChange={(event) => setSessionId(event.target.value)}
            />
          </Field>
        ) : null}

        <div className="between gap-12 wrap">
          <Switch checked={infer} onChange={setInfer} label="开启抽取（infer）" />
          <span className="tiny dim">开启后由模型从文本中抽取多条独立事实；关闭则整段写入一条。</span>
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
