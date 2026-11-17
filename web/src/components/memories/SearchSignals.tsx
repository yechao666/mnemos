import type { MemorySearchHit, MemorySearchSignals, RetrievalWeights } from '@lib/types.ts';
import { RETRIEVAL_SIGNAL_META } from '@lib/constants.ts';
import { Badge } from '@ui';

/**
 * v6.1 检索可解释性：一次命中为什么被召回。
 * 展示综合得分 + vector/keyword/recency/importance/entity 五条信号细条 + matchedOn 标签。
 */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fmtSignal(value: number): string {
  return clamp01(value).toFixed(2);
}

export function SearchSignalBars({
  signals,
  weights,
  compact = true,
}: {
  signals: MemorySearchSignals;
  weights?: Partial<RetrievalWeights> | null;
  compact?: boolean;
}) {
  return (
    <div className={`signal-bars${compact ? ' is-compact' : ''}`} aria-label="检索信号分解">
      {RETRIEVAL_SIGNAL_META.map((meta) => {
        const value = clamp01(signals[meta.key]);
        const weight = weights?.[meta.key];
        const title = `${meta.desc}：${fmtSignal(value)}${
          typeof weight === 'number' ? ` · 权重 ${weight.toFixed(2)}` : ''
        }`;
        return (
          <div className="signal-cell" key={meta.key} title={title}>
            <div className="signal-label">
              <span>{meta.label}</span>
              <span className="signal-value">{fmtSignal(value)}</span>
            </div>
            <div className="signal-track">
              <span
                className="signal-fill"
                style={{
                  width: `${value * 100}%`,
                  background: `linear-gradient(90deg, var(--${meta.tone}), color-mix(in srgb, var(--${meta.tone}) 55%, #ffffff))`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MATCHED_ON_LABEL: Record<string, string> = {
  vector: '向量',
  embedding: '向量',
  semantic: '向量',
  keyword: '关键词',
  fts: '关键词',
  content: '内容',
  tags: '标签',
  recency: '时效',
  importance: '重要度',
  entity: '实体',
  entities: '实体',
  person: '按人',
  scope: '共享',
  shared: '共享',
};

export function matchedOnLabel(value: string): string {
  return MATCHED_ON_LABEL[value.toLowerCase()] ?? value;
}

export function MatchedOnTags({ matchedOn }: { matchedOn: string[] }) {
  if (!matchedOn.length) return null;
  return (
    <div className="chip-row">
      <span className="tiny dim">命中</span>
      {matchedOn.slice(0, 6).map((item) => (
        <span className="chip" key={item} title={`matched on ${item}`}>
          {matchedOnLabel(item)}
        </span>
      ))}
      {matchedOn.length > 6 ? <span className="tiny dim">+{matchedOn.length - 6}</span> : null}
    </div>
  );
}

/** 列表行 / 抽屉里的检索解释块。 */
export function SearchHitInsight({
  hit,
  weights,
}: {
  hit: MemorySearchHit;
  weights?: Partial<RetrievalWeights> | null;
}) {
  return (
    <div className="search-hit-insight">
      <div className="search-hit-score" title="综合得分 = Σ 权重 × 信号">
        <span className="search-hit-score-value">{hit.score.toFixed(3)}</span>
        <span className="tiny dim">综合得分</span>
      </div>
      <div className="search-hit-signals">
        <SearchSignalBars signals={hit.signals} weights={weights} />
        {hit.matchedOn.length ? <MatchedOnTags matchedOn={hit.matchedOn} /> : null}
      </div>
    </div>
  );
}

/** 检索响应摘要：模式 / 命中数 / 耗时 / 策略。 */
export function SearchStrategyBadges({
  modeLabel,
  count,
  tookMs,
  strategy,
}: {
  modeLabel: string;
  count: number;
  tookMs: number | null;
  strategy?: string;
}) {
  return (
    <div className="chip-row">
      <Badge tone="violet" size="sm" dot>
        {modeLabel}
      </Badge>
      <span className="chip mono">{count} 命中</span>
      <span className="chip mono" title="服务端检索耗时">
        {tookMs == null ? '—' : tookMs < 1 ? '<1ms' : `${Math.round(tookMs)}ms`}
      </span>
      {strategy ? (
        <span className="chip mono" title="检索策略">
          {strategy}
        </span>
      ) : null}
    </div>
  );
}
