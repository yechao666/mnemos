import type { LlmUsageSummary } from '@lib/types.ts';
import { LLM_STAGES, LLM_STAGE_LABELS } from '@lib/constants.ts';
import { llmErrorHint } from '@lib/api.ts';
import { fmtInt } from '@lib/format.ts';
import { Callout, Card, EmptyState, IconButton, SectionHead, Stat, Table, type Column } from '@ui';

function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

const EMPTY_USAGE: LlmUsageSummary = {
  stage: 'brief',
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  estimatedCost: 0,
};

/** 近 30 天按 stage 的 calls / tokens / 估算成本。 */
export function UsageSection({
  usage,
  loading,
  error,
  onRefresh,
}: {
  usage: LlmUsageSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
}) {
  const byStage = new Map(usage.map((item) => [item.stage, item]));
  const ordered = LLM_STAGES.map((item) => byStage.get(item.value) ?? { ...EMPTY_USAGE, stage: item.value });
  const known = new Set(LLM_STAGES.map((item) => item.value));
  const extra = usage.filter((item) => !known.has(item.stage));
  const rows = [...ordered, ...extra];

  const totals = rows.reduce(
    (acc, item) => ({
      calls: acc.calls + item.calls,
      promptTokens: acc.promptTokens + item.promptTokens,
      completionTokens: acc.completionTokens + item.completionTokens,
      estimatedCost: acc.estimatedCost + item.estimatedCost,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0 },
  );

  const columns: Column<LlmUsageSummary>[] = [
    {
      key: 'stage',
      header: '阶段',
      render: (row) => (
        <div>
          <div className="strong">{LLM_STAGE_LABELS[row.stage] ?? row.stage}</div>
          <div className="tiny dim mono">{row.stage}</div>
        </div>
      ),
    },
    {
      key: 'calls',
      header: '调用次数',
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.calls)}</span>,
    },
    {
      key: 'promptTokens',
      header: '输入 tokens',
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.promptTokens)}</span>,
    },
    {
      key: 'completionTokens',
      header: '输出 tokens',
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.completionTokens)}</span>,
    },
    {
      key: 'estimatedCost',
      header: '估算成本',
      align: 'right',
      render: (row) => <span className="mono">{fmtCost(row.estimatedCost)}</span>,
    },
  ];

  return (
    <div className="vstack gap-16">
      <div className="kpi-grid">
        <Stat
          label="调用次数"
          value={fmtInt(totals.calls)}
          icon="activity"
          tone="violet"
          hint="近 30 天 · 全部阶段"
        />
        <Stat
          label="输入 tokens"
          value={fmtInt(totals.promptTokens)}
          icon="arrowUpRight"
          tone="cyan"
          hint="prompt tokens"
        />
        <Stat
          label="输出 tokens"
          value={fmtInt(totals.completionTokens)}
          icon="arrowDownRight"
          tone="blue"
          hint="completion tokens"
        />
        <Stat
          label="估算成本"
          value={fmtCost(totals.estimatedCost)}
          icon="trending"
          tone="amber"
          hint="按供应商价格 / 1M tokens"
        />
      </div>

      <Card>
        <div style={{ padding: '14px 16px 0' }}>
          <SectionHead
            title="用量（近 30 天）"
            desc="按阶段汇总调用与成本；价格取供应商的 $ / 1M tokens，仅估算，不产生账单。"
            actions={
              <IconButton
                icon="refresh"
                label="刷新用量"
                size="sm"
                disabled={loading}
                onClick={() => void onRefresh()}
              />
            }
          />
        </div>

        <div style={{ padding: loading || error || totals.calls === 0 ? 16 : 0 }}>
          {error ? (
            <Callout tone="amber" icon="alert">
              <div className="between wrap" style={{ gap: 10 }}>
                <span>无法读取 LLM 用量：{llmErrorHint(error)}</span>
                <button type="button" className="btn btn-sm" onClick={() => void onRefresh()}>
                  重试
                </button>
              </div>
            </Callout>
          ) : loading ? (
            <div className="loading-block">
              <span className="spinner-lg" />
              <span>正在汇总近 30 天用量…</span>
            </div>
          ) : totals.calls === 0 ? (
            <EmptyState
              icon="activity"
              title="近 30 天暂无 LLM 调用"
              description="配置供应商并让阶段产生调用后，这里会按阶段展示 calls、tokens 与估算成本。"
              compact
            />
          ) : null}
        </div>

        {!error && !loading && totals.calls > 0 ? (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.stage}
            empty={<EmptyState title="暂无数据" compact />}
          />
        ) : null}
      </Card>
    </div>
  );
}
