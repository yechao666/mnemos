import { useEffect, useMemo, useState } from 'react';
import type { Webhook, WebhookEventType, WebhookInput, WebhookWithSecret } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { Button, Callout, Checkbox, Field, Input, Modal, Switch, Textarea } from '@ui';
import {
  DEFAULT_EVENT_TYPES,
  isHttpsUrl,
  mergeEventOptions,
  validateWebhookUrl,
  type WebhookEventOption,
} from './shared.tsx';

const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;

export function WebhookFormModal({
  open,
  mode,
  projectId,
  webhook,
  options,
  onClose,
  onCreated,
  onUpdated,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  projectId: string;
  webhook: Webhook | null;
  options: WebhookEventOption[];
  onClose: () => void;
  onCreated: (created: WebhookWithSecret) => void;
  onUpdated: (updated: Webhook) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>(DEFAULT_EVENT_TYPES);
  const [enabled, setEnabled] = useState(true);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetId = webhook?.id ?? null;

  useEffect(() => {
    if (!open) return;
    const editing = mode === 'edit' && webhook;
    setName(editing ? webhook.name : '');
    setUrl(editing ? webhook.url : '');
    setDescription(editing ? webhook.description : '');
    setEventTypes(editing && webhook.eventTypes.length > 0 ? webhook.eventTypes : DEFAULT_EVENT_TYPES);
    setEnabled(editing ? webhook.enabled : true);
    setTouched(false);
    setSubmitting(false);
    setError(null);
    // 仅在打开或目标切换时重置表单，避免列表刷新覆盖正在编辑的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, targetId]);

  const orderedOptions = useMemo(() => mergeEventOptions(options), [options]);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? '请输入订阅名称'
      : trimmedName.length > MAX_NAME
        ? `名称不能超过 ${MAX_NAME} 个字符`
        : null;
  const urlError = validateWebhookUrl(url);
  const eventsError = eventTypes.length === 0 ? '至少选择一个事件类型' : null;
  const descriptionError =
    description.trim().length > MAX_DESCRIPTION ? `描述不能超过 ${MAX_DESCRIPTION} 个字符` : null;
  const valid = !nameError && !urlError && !eventsError && !descriptionError;

  const toggleEvent = (type: WebhookEventType, checked: boolean) => {
    setEventTypes((prev) => (checked ? [...prev, type] : prev.filter((item) => item !== type)));
  };

  const selectAll = () => setEventTypes(orderedOptions.map((option) => option.type));
  const clearAll = () => setEventTypes([]);

  const submit = async () => {
    setTouched(true);
    if (!valid || submitting || !projectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const orderedTypes = orderedOptions
        .map((option) => option.type)
        .filter((type) => eventTypes.includes(type));
      const input: WebhookInput = {
        name: trimmedName,
        url: url.trim(),
        eventTypes: orderedTypes,
        description: description.trim(),
        enabled,
      };
      if (mode === 'edit' && webhook) {
        const updated = await api.webhooks.update(webhook.id, input);
        onUpdated(updated);
      } else {
        const created = await api.webhooks.create(projectId, input);
        onCreated(created);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存订阅失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const editing = mode === 'edit';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? '编辑事件订阅' : '新建事件订阅'}
      description="事件触发后，Mnemos 会以 POST + JSON 推送到该地址，并使用订阅密钥签名。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={editing ? 'check' : 'plus'}
            loading={submitting}
            onClick={() => {
              void submit();
            }}
          >
            {editing ? '保存更改' : '创建订阅'}
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <Field
          label="订阅名称"
          htmlFor="webhook-name"
          required
          error={touched && nameError ? nameError : undefined}
          hint="用于识别接收方，例如「订单服务 · 记忆同步」。"
        >
          <Input
            id="webhook-name"
            value={name}
            autoFocus
            placeholder="例如：订单服务 · 记忆同步"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>

        <Field
          label="推送地址"
          htmlFor="webhook-url"
          required
          error={touched && urlError ? urlError : undefined}
          hint="支持 http 与 https；默认拒绝回环与内网地址（本地调试需服务端开启 MNEMOS_WEBHOOK_ALLOW_PRIVATE），生产环境请使用 HTTPS。"
        >
          <Input
            id="webhook-url"
            className="mono"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://example.com/hooks/mnemos"
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>

        {touched && !urlError && url.trim() && !isHttpsUrl(url) ? (
          <Callout tone="amber" icon="alert">
            当前地址使用明文 HTTP。签名可以防止伪造，但事件内容仍可能被中间人读取，建议尽快切换到 HTTPS。
          </Callout>
        ) : null}

        <Field
          label="描述"
          htmlFor="webhook-description"
          error={touched && descriptionError ? descriptionError : undefined}
          hint="可选。说明该订阅的消费方与用途，便于团队协作排查。"
        >
          <Textarea
            id="webhook-description"
            value={description}
            placeholder="例如：同步订单事件到内部事件总线，由数据平台消费。"
            style={{ minHeight: 68 }}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field
          label="事件类型"
          required
          error={touched && eventsError ? eventsError : undefined}
          hint="只订阅服务实际消费的事件，减少无效投递与重试压力。"
        >
          <div className="vstack gap-10">
            <div className="toolbar">
              <span className="tiny dim">已选择 {eventTypes.length} / {orderedOptions.length} 项</span>
              <div className="toolbar-right">
                <Button size="sm" variant="ghost" onClick={selectAll}>
                  全选
                </Button>
                <Button size="sm" variant="ghost" onClick={clearAll}>
                  清空
                </Button>
              </div>
            </div>
            <div className="grid grid-2" style={{ gap: 10 }}>
              {orderedOptions.map((option) => (
                <Checkbox
                  key={option.type}
                  checked={eventTypes.includes(option.type)}
                  onChange={(checked) => toggleEvent(option.type, checked)}
                  label={
                    <span className="vstack gap-2" style={{ minWidth: 0 }}>
                      <span className="hstack gap-6 wrap">
                        <span className="mono tiny">{option.type}</span>
                        <span className="tiny dim">· {option.label}</span>
                      </span>
                      <span className="tiny dim" style={{ lineHeight: 1.5 }}>
                        {option.description}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          </div>
        </Field>

        <Field
          label="启用状态"
          hint="停用后不再投递新事件，已有投递记录与密钥保留；可随时重新启用。"
        >
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label={<span className="small">{enabled ? '启用订阅' : '暂停投递'}</span>}
          />
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
