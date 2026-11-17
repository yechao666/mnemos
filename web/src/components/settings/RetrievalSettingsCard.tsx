import type { CSSProperties } from 'react';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  SectionHead,
  Select,
  Switch,
} from '@ui';
import {
  DEFAULT_RETRIEVAL_SETTINGS,
  EMBEDDING_MODELS,
  RETRIEVAL_MODES,
  RETRIEVAL_SIGNAL_META,
} from '@lib/constants.ts';
import type { MemorySearchMode, RetrievalSignal } from '@lib/types.ts';

/** 检索设置表单值：数字在表单里保持字符串，便于输入过程（0.4 / 0.45）。 */
export interface RetrievalFormValue {
  mode: MemorySearchMode;
  weights: Record<RetrievalSignal, string>;
  embeddingModel: string;
  mergeThreshold: string;
  dedupeThreshold: string;
  autoExtractEntities: boolean;
}

export function retrievalFormDefaults(settings: Record<string, unknown> | undefined): RetrievalFormValue {
  const rawWeights = (settings?.retrievalWeights ?? {}) as Record<string, unknown>;
  const toText = (value: unknown, fallback: number): string => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? String(parsed) : String(fallback);
  };
  const mode = settings?.retrievalMode;
  return {
    mode: mode === 'keyword' || mode === 'vector' ? mode : DEFAULT_RETRIEVAL_SETTINGS.retrievalMode,
    weights: {
      vector: toText(rawWeights.vector, DEFAULT_RETRIEVAL_SETTINGS.retrievalWeights.vector),
      keyword: toText(rawWeights.keyword, DEFAULT_RETRIEVAL_SETTINGS.retrievalWeights.keyword),
      recency: toText(rawWeights.recency, DEFAULT_RETRIEVAL_SETTINGS.retrievalWeights.recency),
      importance: toText(rawWeights.importance, DEFAULT_RETRIEVAL_SETTINGS.retrievalWeights.importance),
      entity: toText(rawWeights.entity, DEFAULT_RETRIEVAL_SETTINGS.retrievalWeights.entity),
    },
    embeddingModel:
      typeof settings?.embeddingModel === 'string' && settings.embeddingModel
        ? settings.embeddingModel
        : DEFAULT_RETRIEVAL_SETTINGS.embeddingModel,
    mergeThreshold: toText(settings?.mergeThreshold, DEFAULT_RETRIEVAL_SETTINGS.mergeThreshold),
    dedupeThreshold: toText(settings?.dedupeThreshold, DEFAULT_RETRIEVAL_SETTINGS.dedupeThreshold),
    autoExtractEntities: settings?.autoExtractEntities !== false,
  };
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 分区设置里的「检索与写管线」卡片（v6.1 P0）：
 * 检索模式、5 项权重、embedding 模型、merge/dedupe 阈值、自动抽取实体。
 * 表单受控于 SettingsPage 的 FormState，随「保存设置」一起提交。
 */
export function RetrievalSettingsCard({
  value,
  onChange,
}: {
  value: RetrievalFormValue;
  onChange: (patch: Partial<RetrievalFormValue>) => void;
}) {
  const number = (key: RetrievalSignal): number => toNumber(value.weights[key]);
  const sum = RETRIEVAL_SIGNAL_META.reduce((total, meta) => total + number(meta.key), 0);
  const sumOk = Math.abs(sum - 1) < 0.0001;
  const merge = toNumber(value.mergeThreshold);
  const dedupe = toNumber(value.dedupeThreshold);
  const thresholdsOutOfRange = merge < 0 || merge > 1 || dedupe < 0 || dedupe > 1;
  const dedupeBelowMerge = dedupe < merge;

  const patchWeight = (key: RetrievalSignal, next: string) => {
    const cleaned = next.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    onChange({ weights: { ...value.weights, [key]: cleaned } });
  };

  const normalizeWeights = () => {
    if (sum <= 0) {
      const even = (1 / RETRIEVAL_SIGNAL_META.length).toFixed(3);
      const weights = Object.fromEntries(
        RETRIEVAL_SIGNAL_META.map((meta) => [meta.key, even]),
      ) as Record<RetrievalSignal, string>;
      onChange({ weights });
      return;
    }
    const rounded: Record<RetrievalSignal, number> = {} as Record<RetrievalSignal, number>;
    for (const meta of RETRIEVAL_SIGNAL_META) {
      rounded[meta.key] = Math.round((number(meta.key) / sum) * 1000) / 1000;
    }
    // 把舍入误差补到 vector，保证展示的和精确为 1.000。
    const others = RETRIEVAL_SIGNAL_META
      .filter((meta) => meta.key !== 'vector')
      .reduce((total, meta) => total + rounded[meta.key], 0);
    rounded.vector = Math.round((1 - others) * 1000) / 1000;
    onChange({
      weights: Object.fromEntries(
        RETRIEVAL_SIGNAL_META.map((meta) => [meta.key, String(rounded[meta.key])]),
      ) as Record<RetrievalSignal, string>,
    });
  };

  const embeddingOptions = EMBEDDING_MODELS.some((option) => option.value === value.embeddingModel)
    ? EMBEDDING_MODELS
    : [...EMBEDDING_MODELS, { value: value.embeddingModel, label: `${value.embeddingModel}（自定义）` }];

  return (
    <div id="retrieval">
      <Card pad>
        <SectionHead
          title="检索与写管线"
          desc="混合检索模式、5 项信号权重、embedding 模型，以及写入时的去重 / 合并阈值。保存后新检索与新写入立即生效。"
          actions={<Badge tone="violet" size="sm">v6.1 P0</Badge>}
        />

        <div className="grid grid-2 mt-16" style={{ alignItems: 'start', gap: 18 }}>
          <div className="vstack gap-14">
            <Field
              label="检索模式"
              htmlFor="settings-retrieval-mode"
              hint={RETRIEVAL_MODES.find((item) => item.value === value.mode)?.desc}
            >
              <Select
                id="settings-retrieval-mode"
                options={RETRIEVAL_MODES.map((item) => ({ value: item.value, label: item.label }))}
                value={value.mode}
                onChange={(event) => onChange({ mode: event.target.value as MemorySearchMode })}
              />
            </Field>

            <Field label="Embedding 模型" htmlFor="settings-embedding-model" hint="失败时服务端回退本地模型；已写入记忆由异步任务补齐向量。">
              <Select
                id="settings-embedding-model"
                options={embeddingOptions}
                value={value.embeddingModel}
                onChange={(event) => onChange({ embeddingModel: event.target.value })}
              />
            </Field>

            <div className="between">
              <div>
                <div className="small">自动抽取实体</div>
                <div className="tiny dim">写入后异步 extract 任务；P2 图谱与 entity 信号依赖它。</div>
              </div>
              <Switch
                checked={value.autoExtractEntities}
                onChange={(next) => onChange({ autoExtractEntities: next })}
              />
            </div>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label="合并阈值（mergeThreshold）" htmlFor="settings-merge" hint="相似度 ≥ 该值时合并进已有记忆。">
                <Input
                  id="settings-merge"
                  value={value.mergeThreshold}
                  inputMode="decimal"
                  onChange={(event) => onChange({ mergeThreshold: event.target.value.replace(/[^0-9.]/g, '') })}
                />
              </Field>
              <Field label="去重阈值（dedupeThreshold）" htmlFor="settings-dedupe" hint="≥ 该值视为重复，不再新增（建议 ≥ 合并阈值）。">
                <Input
                  id="settings-dedupe"
                  value={value.dedupeThreshold}
                  inputMode="decimal"
                  onChange={(event) => onChange({ dedupeThreshold: event.target.value.replace(/[^0-9.]/g, '') })}
                />
              </Field>
            </div>

            {thresholdsOutOfRange ? (
              <Callout tone="red" icon="alert">
                阈值必须在 0–1 之间（当前 merge={value.mergeThreshold || '—'}，dedupe={value.dedupeThreshold || '—'}）。
              </Callout>
            ) : dedupeBelowMerge ? (
              <Callout tone="amber" icon="alert">
                去重阈值低于合并阈值：完全重复判定会先于合并触发，建议把去重阈值调到 ≥ 合并阈值。
              </Callout>
            ) : null}
          </div>

          <div>
            <div className="between wrap gap-8">
              <div>
                <div className="small">融合权重</div>
                <div className="tiny dim">score = Σ 权重 × 信号；和应为 1.00。</div>
              </div>
              <div className="hstack gap-6 wrap">
                <Badge tone={sumOk ? 'green' : 'amber'} size="sm" dot>
                  权重和 {sum.toFixed(2)}
                </Badge>
                <Button size="sm" variant="ghost" icon="zap" onClick={normalizeWeights}>
                  一键归一化
                </Button>
              </div>
            </div>

            {!sumOk ? (
              <div className="tiny dim mt-6">
                当前权重和为 {sum.toFixed(2)}，建议为 1.00；服务端会按权重归一化打分，保存前可一键归一化。
              </div>
            ) : (
              <div className="tiny dim mt-6">权重和已为 1.00，信号按比例融合。</div>
            )}

            <div className="weight-list mt-10">
              {RETRIEVAL_SIGNAL_META.map((meta) => {
                const numeric = clamp01(number(meta.key));
                return (
                  <div className="weight-row" key={meta.key}>
                    <div className="weight-head">
                      <span>{meta.label}</span>
                      <span className="tiny dim truncate">{meta.desc}</span>
                    </div>
                    <div className="weight-controls">
                      <input
                        type="range"
                        className="slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={numeric}
                        aria-label={`${meta.label}权重`}
                        onChange={(event) => patchWeight(meta.key, event.target.value)}
                        style={{ '--pct': `${numeric * 100}%` } as CSSProperties}
                      />
                      <Input
                        className="weight-number"
                        value={value.weights[meta.key]}
                        inputMode="decimal"
                        aria-label={`${meta.label}权重数值`}
                        onChange={(event) => patchWeight(meta.key, event.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <Callout tone="slate" icon="info">
          修改后点击右上角「保存设置」生效；检索模式与权重影响下一次 <span className="mono">/memories/search</span>，去重/合并阈值影响下一次写入。
        </Callout>
      </Card>
    </div>
  );
}
