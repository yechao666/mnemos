import { useState, type ReactNode } from 'react';
import type { DreamStatus } from '@lib/types.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Icon, Skeleton } from '@ui';
import { toneForStatus } from '@lib/tone.ts';

/**
 * 人级 / 分区级做梦（增量记忆巩固）状态卡。
 * 状态按需加载：未加载时只显示入口，避免每次打开详情都跑一次聚合查询。
 */
export function DreamCard({
  status,
  loading,
  error,
  running,
  canManage,
  onLoad,
  onRun,
  onRefresh,
  title = '做梦整理',
  desc = '把近期新记忆巩固成洞见；人级做梦只处理该人的私有记忆。',
  badge,
}: {
  status: DreamStatus | null;
  loading: boolean;
  error: string | null;
  running: boolean;
  canManage: boolean;
  onLoad: () => void;
  onRun: () => void;
  onRefresh: () => void;
  title?: string;
  desc?: ReactNode;
  badge?: ReactNode;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const lastRun = status?.lastRun ?? status?.runs?.[0];

  return (
    <Card pad>
      <div className="between wrap gap-12">
        <div className="hstack gap-10" style={{ alignItems: 'flex-start' }}>
          <span className="memory-brief-icon" aria-hidden="true" style={{ background: 'rgba(56,212,240,0.12)', borderColor: 'rgba(56,212,240,0.32)', color: '#9fe9f7' }}>
            <Icon name="zap" size={15} />
          </span>
          <div>
            <div className="hstack gap-8 wrap">
              <span className="strong">{title}</span>
              {badge}
              {status ? (
                <>
                  <Badge tone={status.settings.enabled ? 'green' : 'slate'} size="sm" dot>
                    {status.settings.enabled ? '自动整理开' : '自动整理关'}
                  </Badge>
                  <Badge tone={status.pendingCount > 0 ? 'amber' : 'slate'} size="sm">
                    待整理 {fmtInt(status.pendingCount)}
                  </Badge>
                </>
              ) : null}
            </div>
            <div className="tiny dim mt-4">{desc}</div>
          </div>
        </div>
        <div className="hstack gap-6 wrap">
          {status ? (
            <>
              {status.runs.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={showRuns ? 'chevronUp' : 'chevronDown'}
                  onClick={() => setShowRuns((value) => !value)}
                >
                  运行记录 {status.runs.length}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" icon="refresh" onClick={onRefresh} disabled={loading}>
                刷新
              </Button>
              {canManage ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon="zap"
                  loading={running}
                  disabled={loading || running}
                  onClick={onRun}
                >
                  立即做梦
                </Button>
              ) : null}
            </>
          ) : (
            <Button size="sm" variant="secondary" icon="eye" loading={loading} onClick={onLoad}>
              查看状态
            </Button>
          )}
        </div>
      </div>

      {!status && !loading && !error ? (
        <div className="tiny dim mt-12">
          状态按需读取（GET <span className="mono">/persons/:person/dream</span>），不会阻塞人详情的首屏。
        </div>
      ) : null}

      {loading && !status ? (
        <div className="vstack gap-8 mt-12">
          <Skeleton h={12} w="52%" />
          <Skeleton h={12} w="38%" />
        </div>
      ) : null}

      {error && !status ? (
        <div className="mt-12">
          <ErrorState message={error} onRetry={onLoad} />
        </div>
      ) : null}

      {status ? (
        <>
          <div className="memory-metrics mt-16">
            <div>
              <strong>{fmtInt(status.pendingCount)}</strong>
              <span>待整理记忆</span>
            </div>
            <div>
              <strong>{fmtInt(lastRun?.insightCount ?? 0)}</strong>
              <span>上次洞见</span>
            </div>
            <div>
              <strong>{fmtInt(status.settings.intervalMinutes)}</strong>
              <span>分钟周期</span>
            </div>
            <div className="tiny dim">
              {lastRun
                ? `上次运行 ${fmtRelative(lastRun.finishedAt ?? lastRun.startedAt)}（${lastRun.status}）`
                : '尚未运行过'}
            </div>
          </div>

          {showRuns && status.runs.length ? (
            <div className="memory-run-list mt-12">
              {status.runs.slice(0, 6).map((run) => (
                <div className="memory-run-item" key={run.id}>
                  <div className="memory-run-head">
                    <span className="hstack gap-6">
                      <Badge tone={toneForStatus(run.status)} size="sm" dot>
                        {run.status}
                      </Badge>
                      <span className="tiny dim mono">{run.trigger === 'manual' ? '手动' : '定时'}</span>
                    </span>
                    <span className="tiny dim">{fmtRelative(run.startedAt)}</span>
                  </div>
                  <div className="memory-run-text tiny">
                    输入 {fmtInt(run.inputCount)} 条 → 洞见 {fmtInt(run.insightCount)} 条
                    {run.summary ? ` · ${run.summary}` : ''}
                  </div>
                  {run.error ? <div className="memory-run-error tiny">{run.error}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {status && status.runs.length === 0 && showRuns ? (
        <div className="mt-12">
          <EmptyState compact icon="zap" title="还没有运行记录" description="手动或定时触发一次做梦后会出现在这里。" />
        </div>
      ) : null}
    </Card>
  );
}
