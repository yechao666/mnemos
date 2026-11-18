import { useEffect, useState } from 'react';
import type { LlmProvider, LlmProviderInput, LlmProtocol } from '@lib/types.ts';
import { LLM_PROTOCOLS } from '@lib/constants.ts';
import { api, llmErrorHint } from '@lib/api.ts';
import { Button, Callout, Checkbox, Field, Input, Modal, Select, Switch, useToast } from '@ui';

const PROTOCOL_OPTIONS = LLM_PROTOCOLS.map((item) => ({ value: item.value, label: item.label }));

function priceText(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 新增 / 编辑供应商：API Key 只写不回显，编辑时留空表示保持不变。 */
export function ProviderModal({
  open,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider: LlmProvider | null;
  onClose: () => void;
  onSaved: (saved: LlmProvider) => void | Promise<void>;
}) {
  const toast = useToast();
  const editing = provider !== null;

  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<LlmProtocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [inputPrice, setInputPrice] = useState('0');
  const [outputPrice, setOutputPrice] = useState('0');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setProtocol(provider?.protocol ?? 'openai');
    setBaseUrl(provider?.baseUrl ?? '');
    setDefaultModel(provider?.defaultModel ?? '');
    setInputPrice(String(provider?.inputPrice ?? 0));
    setOutputPrice(String(provider?.outputPrice ?? 0));
    setApiKey('');
    setClearApiKey(false);
    setEnabled(provider?.enabled ?? true);
    setError(null);
  }, [open, provider]);

  const meta = LLM_PROTOCOLS.find((item) => item.value === protocol) ?? LLM_PROTOCOLS[0]!;

  const changeProtocol = (next: LlmProtocol) => {
    const previous = LLM_PROTOCOLS.find((item) => item.value === protocol);
    setProtocol(next);
    const nextMeta = LLM_PROTOCOLS.find((item) => item.value === next);
    if (nextMeta && (!baseUrl.trim() || baseUrl.trim() === previous?.baseUrlHint)) {
      setBaseUrl(nextMeta.baseUrlHint);
    }
  };

  const submit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedName) {
      setError('请填写供应商名称。');
      return;
    }
    if (!trimmedBaseUrl) {
      setError('请填写 Base URL。');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
      setError('Base URL 需以 http:// 或 https:// 开头。');
      return;
    }
    const parsedInputPrice = priceText(inputPrice);
    const parsedOutputPrice = priceText(outputPrice);
    if (parsedInputPrice === null || parsedOutputPrice === null) {
      setError('价格必须是 ≥ 0 的数字（$ / 1M tokens）。');
      return;
    }

    const input: LlmProviderInput = {
      name: trimmedName,
      protocol,
      baseUrl: trimmedBaseUrl,
      defaultModel: defaultModel.trim(),
      inputPrice: parsedInputPrice,
      outputPrice: parsedOutputPrice,
      enabled,
    };
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    if (editing && clearApiKey) input.clearApiKey = true;

    setSubmitting(true);
    setError(null);
    try {
      const saved = provider
        ? await api.llm.providers.update(provider.id, input)
        : await api.llm.providers.create(input);
      toast.success(editing ? '供应商已更新' : '供应商已创建');
      onClose();
      await onSaved(saved);
    } catch (cause) {
      setError(llmErrorHint(cause instanceof Error ? cause.message : null));
    } finally {
      setSubmitting(false);
    }
  };

  const hasKey = editing && provider ? provider.hasApiKey : false;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? '编辑供应商' : '新增供应商'}
      description="后端直连供应商 API，不依赖 DSH。API Key 只写入、不回显；价格用于成本估算。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={() => void submit()}>
            {editing ? '保存修改' : '创建供应商'}
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="名称" required htmlFor="llm-provider-name" hint="组织内唯一，例如「OpenAI 生产」「本地 vLLM」。">
            <Input
              id="llm-provider-name"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="OpenAI 生产"
              autoFocus
            />
          </Field>
          <Field label="协议" htmlFor="llm-provider-protocol" hint={meta.desc}>
            <Select
              id="llm-provider-protocol"
              options={PROTOCOL_OPTIONS}
              value={protocol}
              onChange={(event) => changeProtocol(event.target.value as LlmProtocol)}
            />
          </Field>
        </div>

        <Field label="Base URL" required htmlFor="llm-provider-base" hint={`示例：${meta.baseUrlHint}`}>
          <Input
            id="llm-provider-base"
            className="mono"
            maxLength={500}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={meta.baseUrlHint}
          />
        </Field>

        <Field
          label="默认模型"
          htmlFor="llm-provider-model"
          hint="阶段未覆盖模型时使用；留空则对应阶段必须显式填写模型，否则调用会静默回退。"
        >
          <Input
            id="llm-provider-model"
            className="mono"
            maxLength={200}
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
            placeholder={protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'}
          />
        </Field>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="输入价格" htmlFor="llm-provider-input-price" hint="$ / 1M tokens">
            <Input
              id="llm-provider-input-price"
              inputMode="decimal"
              value={inputPrice}
              onChange={(event) => setInputPrice(event.target.value.replace(/[^0-9.]/g, ''))}
            />
          </Field>
          <Field label="输出价格" htmlFor="llm-provider-output-price" hint="$ / 1M tokens">
            <Input
              id="llm-provider-output-price"
              inputMode="decimal"
              value={outputPrice}
              onChange={(event) => setOutputPrice(event.target.value.replace(/[^0-9.]/g, ''))}
            />
          </Field>
        </div>

        <Field
          label="API Key"
          htmlFor="llm-provider-key"
          hint={
            editing
              ? '留空表示保持现有密钥；写入后只显示掩码。'
              : '可留空，之后在编辑中补充；服务端 AES-256-GCM 加密存储。'
          }
        >
          <Input
            id="llm-provider-key"
            type="password"
            autoComplete="new-password"
            className="mono"
            maxLength={500}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={clearApiKey}
            placeholder={clearApiKey ? '保存后将清除已配置的 API Key' : hasKey ? '留空保持不变' : 'sk-…（只写不回显）'}
          />
        </Field>

        {hasKey ? (
          <Checkbox
            checked={clearApiKey}
            onChange={(next) => {
              setClearApiKey(next);
              if (next) setApiKey('');
            }}
            label="清除已保存的 API Key（后续调用会失败，直到重新配置）"
          />
        ) : null}

        <div className="between">
          <div>
            <div className="small">启用该供应商</div>
            <div className="tiny dim">停用后，引用它的阶段会回退环境变量或确定性逻辑。</div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>

        {error ? <Callout tone="red" icon="alert">{error}</Callout> : null}
      </div>
    </Modal>
  );
}
