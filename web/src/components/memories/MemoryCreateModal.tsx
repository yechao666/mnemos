import { useEffect, useState } from 'react';
import type { Memory, MemoryCategory, MemoryScope } from '@lib/types.ts';
import { MEMORY_CATEGORIES, MEMORY_SCOPES } from '@lib/constants.ts';
import { api } from '@lib/api.ts';
import {
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@ui';
import {
  AttachmentEditor,
  attachmentDraftsToInputs,
  validateAttachmentDrafts,
  type AttachmentDraft,
} from './Attachments.tsx';
import {
  PlaceholderEditor,
  extractPlaceholderKeys,
  placeholderDraftsToMap,
  validatePlaceholderDrafts,
  type PlaceholderDraft,
} from './Placeholders.tsx';

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;

function parseTags(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

/**
 * 新建记忆（v6.1 P2）：
 *  - 人（external id / 内部 id）+ 内容 + scope / category / tags；
 *  - 附件（kind / url / caption，≤10，校验 http(s) URL）；
 *  - 写入走 POST /api/partitions/:p/persons/:person/memories，服务端会去重/合并并异步抽取实体。
 */
export function MemoryCreateModal({
  open,
  partitionId,
  defaultPersonRef = '',
  defaultScope = 'partition',
  defaultCategory = 'fact',
  onClose,
  onCreated,
}: {
  open: boolean;
  partitionId: string;
  /** 从人详情打开时预填该人的 external id。 */
  defaultPersonRef?: string;
  defaultScope?: MemoryScope;
  defaultCategory?: MemoryCategory;
  onClose: () => void;
  onCreated?: (memory: Memory) => void | Promise<void>;
}) {
  const toast = useToast();
  const [personRef, setPersonRef] = useState(defaultPersonRef);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<MemoryScope>(defaultScope);
  const [category, setCategory] = useState<MemoryCategory>(defaultCategory);
  const [tags, setTags] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [placeholders, setPlaceholders] = useState<PlaceholderDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [showAttachmentErrors, setShowAttachmentErrors] = useState(false);
  const [showPlaceholderErrors, setShowPlaceholderErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  // 每次打开重置表单（保留调用方传入的默认人 / scope / 分类）。
  useEffect(() => {
    if (!open) return;
    setPersonRef(defaultPersonRef);
    setText('');
    setScope(defaultScope);
    setCategory(defaultCategory);
    setTags('');
    setAttachments([]);
    setPlaceholders([]);
    setFormError(null);
    setShowAttachmentErrors(false);
    setShowPlaceholderErrors(false);
    setSaving(false);
  }, [open, defaultPersonRef, defaultScope, defaultCategory]);

  // 正文出现新的 {{key}} 时自动补映射行（值由用户填写；删行不会被自动加回除非正文再次变化）。
  useEffect(() => {
    if (!open) return;
    const tokens = extractPlaceholderKeys(text);
    if (!tokens.length) return;
    setPlaceholders((current) => {
      const existing = new Set(current.map((draft) => draft.key.trim()));
      const missing = tokens.filter((key) => !existing.has(key));
      return missing.length ? [...current, ...missing.map((key) => ({ key, value: '' }))] : current;
    });
  }, [open, text]);

  const submit = async () => {
    if (saving) return;
    const person = personRef.trim();
    const content = text.trim();
    if (!person) {
      setFormError('请填写记忆归属人的 external ID（或内部 ID）。');
      return;
    }
    if (!content) {
      setFormError('请填写记忆内容。');
      return;
    }
    if (content.length > 20_000) {
      setFormError('记忆内容最长 20000 字符。');
      return;
    }
    const parsedTags = parseTags(tags);
    const badTag = parsedTags.find((tag) => tag.length > MAX_TAG_LENGTH);
    if (badTag) {
      setFormError(`标签「${badTag.slice(0, 20)}…」超过 ${MAX_TAG_LENGTH} 字符。`);
      return;
    }
    const attachmentError = validateAttachmentDrafts(attachments);
    if (attachmentError) {
      setShowAttachmentErrors(true);
      setFormError(attachmentError);
      return;
    }
    const placeholderError = validatePlaceholderDrafts(content, placeholders);
    if (placeholderError) {
      setShowPlaceholderErrors(true);
      setFormError(placeholderError);
      return;
    }
    const placeholderMap = placeholderDraftsToMap(content, placeholders);

    setSaving(true);
    setFormError(null);
    try {
      const created = await api.persons.createMemory(partitionId, person, {
        text: content,
        scope,
        category,
        tags: parsedTags,
        attachments: attachments.length ? attachmentDraftsToInputs(attachments) : undefined,
        placeholders: Object.keys(placeholderMap).length ? placeholderMap : undefined,
      });
      toast.success(
        attachments.length || Object.keys(placeholderMap).length
          ? `已写入记忆，并附带 ${attachments.length} 个附件、${Object.keys(placeholderMap).length} 个隐私占位符`
          : '已写入记忆（服务端会自动去重 / 合并并异步抽取实体）',
      );
      onClose();
      await onCreated?.(created);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '写入记忆失败';
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="新建记忆"
      description="记忆按「分区 → 人」组织；写入后会触发去重 / 合并与实体抽取，caption 也会参与检索。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" loading={saving} onClick={() => void submit()}>
            写入记忆
          </Button>
        </>
      }
    >
      <div className="vstack gap-12">
        <Field
          label="归属人"
          required
          htmlFor="memory-create-person"
          hint="external ID（App user_id / Agent id）或内部 ID；不存在时按分区设置自动建档。"
        >
          <Input
            id="memory-create-person"
            className="mono"
            value={personRef}
            placeholder="例如 alice / agent-001"
            autoFocus
            onChange={(event) => setPersonRef(event.target.value)}
          />
        </Field>

        <Field
          label="记忆内容"
          required
          htmlFor="memory-create-text"
          hint="自然语言事实、偏好、决策或上下文；敏感值请用 {{key}} 占位并在下方映射中填写真实值，正文不会落明文。"
        >
          <Textarea
            id="memory-create-text"
            value={text}
            maxLength={20_000}
            placeholder="例如：Alice 负责「阿尔法项目」的设计评审，偏好周二下午开会；手机号 {{phone_a1b2}}。"
            style={{ minHeight: 112 }}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>

        <PlaceholderEditor
          value={placeholders}
          onChange={(next) => {
            setPlaceholders(next);
            setFormError(null);
            setShowPlaceholderErrors(false);
          }}
          content={text}
          showErrors={showPlaceholderErrors}
          disabled={saving}
        />

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="可见范围" htmlFor="memory-create-scope" hint={MEMORY_SCOPES.find((item) => item.value === scope)?.desc}>
            <Select
              id="memory-create-scope"
              options={MEMORY_SCOPES.map((item) => ({ value: item.value, label: item.label }))}
              value={scope}
              onChange={(event) => setScope(event.target.value as MemoryScope)}
            />
          </Field>
          <Field label="分类" htmlFor="memory-create-category">
            <Select
              id="memory-create-category"
              options={MEMORY_CATEGORIES.map((item) => ({ value: item.value, label: item.label }))}
              value={category}
              onChange={(event) => setCategory(event.target.value as MemoryCategory)}
            />
          </Field>
        </div>

        <Field label="标签" htmlFor="memory-create-tags" hint={`可选，逗号或空格分隔，最多 ${MAX_TAGS} 个。`}>
          <Input
            id="memory-create-tags"
            value={tags}
            placeholder="例如：项目/阿尔法, 设计评审"
            onChange={(event) => setTags(event.target.value)}
          />
        </Field>

        <AttachmentEditor
          value={attachments}
          onChange={(next) => {
            setAttachments(next);
            setFormError(null);
          }}
          showErrors={showAttachmentErrors}
          disabled={saving}
        />

        {formError ? (
          <Callout tone="red" icon="alert">
            {formError}
          </Callout>
        ) : null}

        <div className="tiny dim">
          附件只保存 URL 与描述（媒体本体由调用方托管）；每记忆最多 10 个，URL 必须以 http(s) 开头。
          占位符映射按 <span className="mono">docs/privacy-rules.md</span> 协议提交：正文只存 token，真实值加密入库；
          分区总开关 <span className="mono">piiRedaction</span> 关闭时，显式提交的映射仍会保存。
        </div>
      </div>
    </Modal>
  );
}
