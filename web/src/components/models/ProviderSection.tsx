import { useState } from 'react';
import type { LlmProvider, LlmTestResult } from '@lib/types.ts';
import { LLM_PROTOCOL_LABEL } from '@lib/constants.ts';
import { api, llmErrorHint } from '@lib/api.ts';
import { fmtMs } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  IconButton,
  SectionHead,
  Skeleton,
  useToast,
} from '@ui';
import { ProviderModal } from './ProviderModal.tsx';

interface TestState {
  loading: boolean;
  result?: LlmTestResult;
  error?: string;
}

function money(value: number): string {
  return `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function keyLabel(provider: LlmProvider): string {
  if (provider.apiKeyMasked) return provider.apiKeyMasked;
  if (provider.hasApiKey) return '已配置（不回显）';
  return '未配置';
}

/** 供应商卡片：增删改、启停、测试连接；密钥只显示掩码。 */
export function ProviderSection({
  providers,
  loading,
  error,
  onRefresh,
  onChanged,
  onDeleted,
}: {
  providers: LlmProvider[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onChanged: () => void | Promise<void>;
  /** 删除后阶段引用会被服务端清空，刷新阶段表以免显示幽灵供应商。 */
  onDeleted?: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProvider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (provider: LlmProvider) => {
    setTests((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    setEditing(provider);
    setModalOpen(true);
  };

  const runTest = async (provider: LlmProvider) => {
    setTests((current) => ({ ...current, [provider.id]: { loading: true } }));
    try {
      const result = await api.llm.providers.test(provider.id);
      setTests((current) => ({
        ...current,
        [provider.id]: { loading: false, result, error: result.ok ? undefined : result.error },
      }));
      if (result.ok) toast.success(`「${provider.name}」连接成功`);
      else toast.warning(result.error ?? '连接测试未通过');
    } catch (cause) {
      const message = llmErrorHint(cause instanceof Error ? cause.message : null);
      setTests((current) => ({ ...current, [provider.id]: { loading: false, error: message } }));
      toast.error(message);
    }
  };

  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.llm.providers.remove(deleteTarget.id);
      toast.success(`已删除「${deleteTarget.name}」`);
      setDeleteTarget(null);
      await onChanged();
      await onDeleted?.();
    } catch (cause) {
      toast.error(llmErrorHint(cause instanceof Error ? cause.message : null));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <div style={{ padding: '14px 16px 0' }}>
        <SectionHead
          title="供应商"
          desc="直连 OpenAI 兼容 / Anthropic API；API Key 只写不回显，价格用于成本估算（$ / 1M tokens）。"
          actions={
            <>
              <IconButton
                icon="refresh"
                label="刷新供应商"
                size="sm"
                disabled={loading}
                onClick={() => void onRefresh()}
              />
              <Button variant="primary" size="sm" icon="plus" onClick={openCreate}>
                新增供应商
              </Button>
            </>
          }
        />
      </div>

      <div style={{ padding: 16 }}>
        {error ? (
          <Callout tone="amber" icon="alert">
            <div className="between wrap" style={{ gap: 10 }}>
              <span>{llmErrorHint(error)}</span>
              <Button size="sm" icon="refresh" onClick={() => void onRefresh()}>重试</Button>
            </div>
          </Callout>
        ) : null}

        {loading && providers.length === 0 ? (
          <div className="grid grid-2">
            {[0, 1].map((index) => (
              <div key={index} className="vstack gap-8">
                <Skeleton h={18} w="45%" />
                <Skeleton h={12} w="80%" />
                <Skeleton h={12} w="65%" />
                <Skeleton h={30} w="55%" />
              </div>
            ))}
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            icon="cpu"
            title="还没有供应商"
            description="添加 OpenAI 兼容或 Anthropic 供应商后，可在下方为每个阶段分配模型。"
            action={<Button size="sm" variant="primary" icon="plus" onClick={openCreate}>新增供应商</Button>}
            compact
          />
        ) : (
          <div className="grid grid-2" style={{ alignItems: 'stretch' }}>
            {providers.map((provider) => {
              const test = tests[provider.id];
              return (
                <Card key={provider.id} pad className="v6-llm-provider">
                  <div className="between" style={{ alignItems: 'flex-start' }}>
                    <div className="hstack gap-10" style={{ minWidth: 0 }}>
                      <span className={`v6-llm-provider-mark tone-${provider.protocol === 'anthropic' ? 'amber' : 'cyan'}`}>
                        <Icon name={provider.protocol === 'anthropic' ? 'sparkles' : 'cpu'} size={15} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="strong truncate">{provider.name || '未命名供应商'}</div>
                        <div className="tiny dim truncate">
                          {LLM_PROTOCOL_LABEL[provider.protocol]}
                          {provider.defaultModel ? ` · ${provider.defaultModel}` : ' · 未设默认模型'}
                        </div>
                      </div>
                    </div>
                    <Badge tone={provider.enabled ? 'green' : 'slate'} size="sm" dot>
                      {provider.enabled ? '启用' : '停用'}
                    </Badge>
                  </div>

                  <div className="v6-llm-meta mt-12">
                    <div>
                      <span className="tiny dim">Base URL</span>
                      <span className="mono tiny truncate" title={provider.baseUrl}>{provider.baseUrl || '—'}</span>
                    </div>
                    <div>
                      <span className="tiny dim">价格 / 1M tokens</span>
                      <span className="mono tiny">输入 {money(provider.inputPrice)} · 输出 {money(provider.outputPrice)}</span>
                    </div>
                    <div>
                      <span className="tiny dim">API Key</span>
                      <span className="mono tiny truncate" title="API Key 永不回显明文">{keyLabel(provider)}</span>
                    </div>
                  </div>

                  {test?.error && !test.result?.ok ? (
                    <div className="mt-12">
                      <Callout tone="red" icon="xCircle">连接失败：{test.error}</Callout>
                    </div>
                  ) : null}
                  {test?.result?.ok ? (
                    <div className="mt-12">
                      <Callout tone="green" icon="checkCircle">
                        连接成功 · 延迟 {fmtMs(test.result.latencyMs)} · 模型 {test.result.model ?? provider.defaultModel ?? '—'}
                      </Callout>
                    </div>
                  ) : null}
                  {test?.loading ? (
                    <div className="tiny dim mt-12">正在发送最小请求验证连通性…</div>
                  ) : null}

                  <div className="hstack gap-8 wrap mt-12" style={{ marginTop: 'auto', paddingTop: 12 }}>
                    <Button
                      size="sm"
                      icon="zap"
                      loading={test?.loading}
                      onClick={() => void runTest(provider)}
                    >
                      测试连接
                    </Button>
                    <Button size="sm" variant="ghost" icon="pencil" onClick={() => openEdit(provider)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleteTarget(provider)}>
                      删除
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <ProviderModal
        open={modalOpen}
        provider={editing}
        onClose={() => setModalOpen(false)}
        onSaved={async () => {
          await onChanged();
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title="删除供应商"
        description={
          deleteTarget
            ? `将删除「${deleteTarget.name}」。引用它的阶段会回退到环境变量或确定性逻辑；此操作会记录到审计日志。`
            : undefined
        }
        confirmLabel="删除供应商"
        loading={deleting}
      />
    </Card>
  );
}
