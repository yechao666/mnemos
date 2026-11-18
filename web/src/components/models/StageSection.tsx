import { Fragment, useEffect, useState } from 'react';
import type { LlmProvider, LlmStage, LlmStageConfig } from '@lib/types.ts';
import { LLM_STAGES, LLM_STAGE_DEFAULTS, LLM_STAGE_LABELS, LLM_LIMITS } from '@lib/constants.ts';
import { api, llmErrorHint } from '@lib/api.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  IconButton,
  Input,
  LoadingBlock,
  SectionHead,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';

interface StageForm {
  providerId: string;
  model: string;
  temperature: string;
  maxTokens: string;
  timeoutMs: string;
  systemPrompt: string;
  enabled: boolean;
}

type StageForms = Record<LlmStage, StageForm>;

function formFromConfig(config: LlmStageConfig | undefined, stage: LlmStage): StageForm {
  const defaults = LLM_STAGE_DEFAULTS[stage];
  return {
    providerId: config?.providerId ?? '',
    model: config?.model ?? '',
    temperature: String(config?.temperature ?? defaults.temperature),
    maxTokens: String(config?.maxTokens ?? defaults.maxTokens),
    timeoutMs: String(config?.timeoutMs ?? defaults.timeoutMs),
    systemPrompt: config?.systemPrompt ?? '',
    enabled: config?.enabled ?? true,
  };
}

function formsFrom(stages: LlmStageConfig[]): StageForms {
  const byStage = new Map(stages.map((item) => [item.stage, item]));
  return Object.fromEntries(
    LLM_STAGES.map((item) => [item.value, formFromConfig(byStage.get(item.value), item.value)]),
  ) as StageForms;
}

function validateForm(form: StageForm): string | null {
  const temperature = Number(form.temperature);
  if (!form.temperature.trim() || !Number.isFinite(temperature)) return '温度必须是数字。';
  if (temperature < LLM_LIMITS.temperatureMin || temperature > LLM_LIMITS.temperatureMax) {
    return `温度需在 ${LLM_LIMITS.temperatureMin}–${LLM_LIMITS.temperatureMax} 之间。`;
  }
  const maxTokens = Number(form.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < LLM_LIMITS.maxTokensMin || maxTokens > LLM_LIMITS.maxTokensMax) {
    return `最大 tokens 需为 ${LLM_LIMITS.maxTokensMin}–${LLM_LIMITS.maxTokensMax} 的整数。`;
  }
  const timeoutMs = Number(form.timeoutMs);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < LLM_LIMITS.timeoutMsMin ||
    timeoutMs > LLM_LIMITS.timeoutMsMax
  ) {
    return `超时需为 ${LLM_LIMITS.timeoutMsMin}–${LLM_LIMITS.timeoutMsMax} 毫秒。`;
  }
  return null;
}

function sameForm(left: StageForm, right: StageForm): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 阶段配置表：brief / dream / profile / privacy / extract。
 * 每行可单独保存（PUT /api/llm/stages/:stage），也可「保存全部」。
 */
export function StageSection({
  stages,
  providers,
  loading,
  error,
  providersLoading = false,
  providersUnavailable = false,
  onRefresh,
  onChanged,
}: {
  stages: LlmStageConfig[];
  providers: LlmProvider[];
  loading: boolean;
  error: string | null;
  /** 供应商仍在加载 / 加载失败时，避免把未解析的 providerId 误标成「已删除」。 */
  providersLoading?: boolean;
  providersUnavailable?: boolean;
  onRefresh: () => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [forms, setForms] = useState<StageForms>(() => formsFrom(stages));
  const [baselines, setBaselines] = useState<StageForms>(() => formsFrom(stages));
  const [expanded, setExpanded] = useState<Set<LlmStage>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Partial<Record<LlmStage, string | null>>>({});
  const [savingRows, setSavingRows] = useState<Partial<Record<LlmStage, boolean>>>({});
  const [savingAll, setSavingAll] = useState(false);

  // 仅在服务端阶段列表变化时重置表单；逐行保存不会触发 refresh，避免覆盖未保存编辑。
  useEffect(() => {
    setForms(formsFrom(stages));
    setBaselines(formsFrom(stages));
    setRowErrors({});
  }, [stages]);

  const patch = (stage: LlmStage, next: Partial<StageForm>) => {
    setForms((current) => ({ ...current, [stage]: { ...current[stage], ...next } }));
  };

  const isDirty = (stage: LlmStage) => !sameForm(forms[stage], baselines[stage]);

  const toggleExpanded = (stage: LlmStage) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  const saveStage = async (stage: LlmStage, silent = false): Promise<boolean> => {
    const form = forms[stage];
    const validation = validateForm(form);
    if (validation) {
      setRowErrors((current) => ({ ...current, [stage]: validation }));
      if (!silent) toast.error(`${LLM_STAGE_LABELS[stage]}：${validation}`);
      return false;
    }
    setSavingRows((current) => ({ ...current, [stage]: true }));
    setRowErrors((current) => ({ ...current, [stage]: null }));
    try {
      const config = await api.llm.stages.update(stage, {
        providerId: form.providerId || null,
        model: form.model.trim() || null,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        timeoutMs: Number(form.timeoutMs),
        systemPrompt: form.systemPrompt.trim() || null,
        enabled: form.enabled,
      });
      const next = formFromConfig(config, stage);
      setForms((current) => ({ ...current, [stage]: next }));
      setBaselines((current) => ({ ...current, [stage]: next }));
      if (!silent) toast.success(`${LLM_STAGE_LABELS[stage]}阶段已保存`);
      return true;
    } catch (cause) {
      const message = llmErrorHint(cause instanceof Error ? cause.message : null);
      setRowErrors((current) => ({ ...current, [stage]: message }));
      if (!silent) toast.error(message);
      return false;
    } finally {
      setSavingRows((current) => ({ ...current, [stage]: false }));
    }
  };

  const saveOne = async (stage: LlmStage) => {
    const ok = await saveStage(stage);
    if (ok) await onChanged();
  };

  const saveAll = async () => {
    if (savingAll) return;
    const dirty = LLM_STAGES.map((item) => item.value).filter((stage) => isDirty(stage));
    if (dirty.length === 0) {
      toast.info('没有需要保存的修改');
      return;
    }
    for (const stage of dirty) {
      const validation = validateForm(forms[stage]);
      if (validation) {
        setRowErrors((current) => ({ ...current, [stage]: validation }));
        toast.error(`${LLM_STAGE_LABELS[stage]}：${validation}`);
        return;
      }
    }
    setSavingAll(true);
    let failed = 0;
    for (const stage of dirty) {
      const ok = await saveStage(stage, true);
      if (!ok) failed += 1;
    }
    setSavingAll(false);
    if (failed > 0) {
      toast.error(`${dirty.length - failed}/${dirty.length} 个阶段已保存，其余失败`);
    } else {
      toast.success(`已保存 ${dirty.length} 个阶段`);
    }
    if (failed < dirty.length) await onChanged();
  };

  const providerOptions = [
    { value: '', label: '未分配 · 回退 env' },
    ...providers.map((provider) => ({
      value: provider.id,
      label: provider.enabled ? provider.name : `${provider.name}（已停用）`,
    })),
  ];

  return (
    <Card>
      <div style={{ padding: '14px 16px 0' }}>
        <SectionHead
          title="阶段配置"
          desc="为每个阶段选择供应商与模型；未配置时回退环境变量 MNEMOS_LLM_*，调用失败静默回退确定性逻辑。"
          actions={
            <>
              <IconButton
                icon="refresh"
                label="刷新阶段配置"
                size="sm"
                disabled={loading || savingAll}
                onClick={() => void onRefresh()}
              />
              <Button
                variant="primary"
                size="sm"
                icon="check"
                loading={savingAll}
                onClick={() => void saveAll()}
              >
                保存全部
              </Button>
            </>
          }
        />
      </div>

      {error ? (
        <div style={{ padding: '12px 16px 0' }}>
          <Callout tone="amber" icon="alert">
            <div className="between wrap" style={{ gap: 10 }}>
              <span>{llmErrorHint(error)}</span>
              <Button size="sm" icon="refresh" onClick={() => void onRefresh()}>重试</Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {loading && stages.length === 0 ? (
        <LoadingBlock label="正在载入阶段配置…" />
      ) : (
        <div className="table-wrap mt-12">
          <table className="table v6-llm-stage-table">
            <thead>
              <tr>
                <th style={{ minWidth: 168 }}>阶段</th>
                <th style={{ minWidth: 186 }}>供应商</th>
                <th style={{ minWidth: 186 }}>模型覆盖</th>
                <th style={{ minWidth: 86 }}>温度</th>
                <th style={{ minWidth: 104 }}>最大 tokens</th>
                <th style={{ minWidth: 108 }}>超时（ms）</th>
                <th style={{ minWidth: 118 }}>系统提示词</th>
                <th style={{ minWidth: 64 }}>启用</th>
                <th style={{ minWidth: 88 }} />
              </tr>
            </thead>
            <tbody>
              {LLM_STAGES.map((meta) => {
                const stage = meta.value;
                const form = forms[stage];
                const provider = providers.find((item) => item.id === form.providerId);
                const dirty = isDirty(stage);
                const isExpanded = expanded.has(stage);
                const rowError = rowErrors[stage];
                const missingProvider = Boolean(form.providerId) && !provider;
                const missingLabel = providersLoading
                  ? '供应商载入中…'
                  : providersUnavailable
                    ? '供应商列表未加载'
                    : '已删除的供应商';
                return (
                  <Fragment key={stage}>
                    <tr>
                      <td>
                        <div className="strong">{meta.label}</div>
                        <div className="tiny dim v6-llm-stage-desc">{meta.desc}</div>
                      </td>
                      <td>
                        <Select
                          options={
                            missingProvider
                              ? [...providerOptions, { value: form.providerId, label: missingLabel }]
                              : providerOptions
                          }
                          value={form.providerId}
                          onChange={(event) => patch(stage, { providerId: event.target.value })}
                          aria-label={`${meta.label}阶段供应商`}
                        />
                        {provider && !provider.enabled ? (
                          <div className="tiny v6-llm-warn">供应商已停用，调用会回退</div>
                        ) : null}
                      </td>
                      <td>
                        <Input
                          value={form.model}
                          className="mono"
                          placeholder={provider?.defaultModel ? `默认：${provider.defaultModel}` : '留空用供应商默认模型'}
                          onChange={(event) => patch(stage, { model: event.target.value })}
                          aria-label={`${meta.label}阶段模型覆盖`}
                        />
                      </td>
                      <td>
                        <Input
                          value={form.temperature}
                          inputMode="decimal"
                          style={{ width: 72 }}
                          onChange={(event) =>
                            patch(stage, { temperature: event.target.value.replace(/[^0-9.]/g, '') })
                          }
                          aria-label={`${meta.label}阶段温度`}
                        />
                      </td>
                      <td>
                        <Input
                          value={form.maxTokens}
                          inputMode="numeric"
                          style={{ width: 92 }}
                          onChange={(event) =>
                            patch(stage, { maxTokens: event.target.value.replace(/[^0-9]/g, '') })
                          }
                          aria-label={`${meta.label}阶段最大 tokens`}
                        />
                      </td>
                      <td>
                        <Input
                          value={form.timeoutMs}
                          inputMode="numeric"
                          style={{ width: 96 }}
                          onChange={(event) =>
                            patch(stage, { timeoutMs: event.target.value.replace(/[^0-9]/g, '') })
                          }
                          aria-label={`${meta.label}阶段超时`}
                        />
                      </td>
                      <td>
                        <div className="hstack gap-6">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={isExpanded ? 'chevronUp' : 'chevronDown'}
                            onClick={() => toggleExpanded(stage)}
                          >
                            提示词
                          </Button>
                          {form.systemPrompt.trim() ? (
                            <Badge tone="violet" size="sm">自定义</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <Switch
                          checked={form.enabled}
                          onChange={(next) => patch(stage, { enabled: next })}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Button
                          size="sm"
                          variant={dirty ? 'primary' : 'ghost'}
                          icon="check"
                          loading={Boolean(savingRows[stage])}
                          disabled={!dirty || savingAll}
                          onClick={() => void saveOne(stage)}
                        >
                          保存
                        </Button>
                      </td>
                    </tr>

                    {rowError ? (
                      <tr className="v6-llm-stage-subrow">
                        <td colSpan={9}>
                          <div className="field-error" role="alert">{rowError}</div>
                        </td>
                      </tr>
                    ) : null}

                    {isExpanded ? (
                      <tr className="v6-llm-stage-subrow v6-llm-stage-prompt-row">
                        <td colSpan={9}>
                          <div className="vstack gap-8">
                            <div className="between wrap">
                              <div className="tiny dim">
                                系统提示词 · 留空使用内置提示词；仅覆盖「{meta.label}」阶段
                              </div>
                              <span className="tiny dim mono">{form.systemPrompt.length} 字符</span>
                            </div>
                            <Textarea
                              value={form.systemPrompt}
                              maxLength={8000}
                              onChange={(event) => patch(stage, { systemPrompt: event.target.value })}
                              placeholder="例如：你是一名记忆助理，请基于给定资料输出简洁、可核对的中文简报。"
                              style={{ minHeight: 96 }}
                            />
                            <div className="hstack gap-8">
                              <Button
                                size="sm"
                                variant="ghost"
                                icon="x"
                                onClick={() => patch(stage, { systemPrompt: '' })}
                              >
                                清空
                              </Button>
                              <span className="tiny dim">修改后点击该行「保存」或右上角「保存全部」。</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ padding: '0 16px 16px' }} className="tiny dim">
        温度 0–2（默认 0.2）；最大 tokens 1–8192；超时 1000–120000ms。阶段未配置供应商时按环境变量回退，
        两者都没有则不调用 LLM，走确定性逻辑。
      </div>
    </Card>
  );
}
