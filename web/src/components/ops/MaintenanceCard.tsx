import { useState } from 'react';
import type { MaintenanceRun, OpsMaintenanceResult } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtFullDateTime, fmtInt, fmtMs, fmtRelative } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Switch,
  Table,
  useToast,
  type Column,
} from '@ui';
import {
  Metric,
  maintenanceDuration,
  maintenanceKindLabel,
  maintenanceStatusMeta,
  summarizeMaintenance,
} from './shared.tsx';

/**
 * 「维护」卡片：执行归档 / 清理任务（支持演练与 VACUUM），并展示最近维护记录。
 */
export function MaintenanceCard({
  fallback,
  reloadKey,
  enabled,
  onRan,
}: {
  fallback: MaintenanceRun[];
  reloadKey: number;
  enabled: boolean;
  onRan: () => void;
}) {
  const toast = useToast();
  const [dryRun, setDryRun] = useState(true);
  const [vacuum, setVacuum] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OpsMaintenanceResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const { data, loading, error, refresh } = useAsync(
    () => api.ops.maintenanceHistory(20),
    [reloadKey],
    enabled,
  );

  const rows = data ?? fallback;
  const degraded = Boolean(error) && !data;

  const runMaintenance = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    try {
      const outcome = await api.ops.maintenance({ dryRun, vacuum: vacuum && !dryRun });
      setResult(outcome);
      toast.success(
        outcome.dryRun ? '维护演练已完成，未写入数据库' : '维护任务已完成',
        outcome.dryRun ? '演练完成' : '维护完成',
      );
      await refresh();
      onRan();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : '维护任务执行失败，请稍后重试。';
      setRunError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  const columns: Column<MaintenanceRun>[] = [
    {
      key: 'startedAt',
      header: '时间',
      width: 130,
      render: (run) => (
        <span className="tiny muted nowrap" title={fmtFullDateTime(run.startedAt)}>
          {fmtRelative(run.startedAt)}
        </span>
      ),
    },
    {
      key: 'kind',
      header: '类型',
      width: 116,
      render: (run) => <span className="small muted nowrap">{maintenanceKindLabel(run.kind)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 92,
      render: (run) => {
        const meta = maintenanceStatusMeta(run.status);
        return (
          <Badge tone={meta.tone} size="sm" dot>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'summary',
      header: '耗时 / 摘要',
      render: (run) => (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <span className="small muted truncate" title={summarizeMaintenance(run)}>
            {summarizeMaintenance(run)}
          </span>
          <span className="tiny dim mono">{maintenanceDuration(run)}</span>
        </div>
      ),
    },
    {
      key: 'error',
      header: '错误',
      width: 220,
      render: (run) =>
        run.error ? (
          <span className="tiny truncate" style={{ color: 'var(--red)', display: 'block', maxWidth: 210 }} title={run.error}>
            {run.error}
          </span>
        ) : (
          <span className="tiny dim">—</span>
        ),
    },
  ];

  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">维护</div>
          <div className="card-sub">按保留期归档过期记忆、清理软删除记录与会话；可选 VACUUM 回收磁盘</div>
        </div>
        <Badge tone={result ? (result.dryRun ? 'cyan' : 'green') : 'slate'} size="sm">
          {result ? (result.dryRun ? '最近一次为演练' : '最近一次已执行') : '尚未执行'}
        </Badge>
      </div>
      <div className="card-body">
        <div className="hstack wrap gap-20">
          <Switch
            checked={dryRun}
            onChange={(next) => {
              setDryRun(next);
              if (next) setVacuum(false);
            }}
            label="演练模式（dryRun）"
            disabled={running}
          />
          <Switch checked={vacuum} onChange={setVacuum} label="执行 VACUUM" disabled={running || dryRun} />
          <Button
            className="ml-auto"
            size="sm"
            variant="primary"
            icon="play"
            loading={running}
            onClick={() => void runMaintenance()}
          >
            {dryRun ? '立即演练' : '立即执行'}
          </Button>
        </div>
        <div className="tiny dim mt-8">
          演练模式只统计将受影响的数据，不写入数据库；VACUUM 会短暂锁定数据库，建议在低峰期执行。
        </div>

        {runError ? (
          <div className="mt-12">
            <Callout tone="red" icon="alert">{runError}</Callout>
          </div>
        ) : null}

        {result ? (
          <div className="mt-12">
            <Callout tone={result.dryRun ? 'cyan' : 'green'} icon="checkCircle">
              <strong>{result.dryRun ? '演练完成，未写入数据库' : '维护完成'}</strong>
              <span className="tiny dim"> · 耗时 {fmtMs(result.durationMs)}</span>
            </Callout>
            <div className="metric-grid mt-12">
              <Metric label="归档过期记忆" value={fmtInt(result.expiredArchived)} />
              <Metric label="清理已删除记忆" value={fmtInt(result.deletedPurged)} />
              <Metric label="清理幂等记录" value={fmtInt(result.idempotencyPurged)} />
              <Metric label="清理过期会话" value={fmtInt(result.sessionsPurged)} />
              <Metric label="WAL 检查点" value={result.walCheckpointed ? '已执行' : '跳过'} />
              <Metric label="VACUUM" value={result.vacuumed ? '已执行' : '跳过'} />
            </div>
          </div>
        ) : null}

        <div className="divider mt-16" />

        <div className="between wrap gap-8 mt-12">
          <div className="hstack gap-8">
            <span className="section-title">最近维护记录</span>
            <Badge tone="slate" size="sm">共 {fmtInt(rows.length)} 条</Badge>
          </div>
          <Button size="sm" icon="refresh" loading={loading} onClick={() => void refresh()}>
            刷新
          </Button>
        </div>

        {degraded ? (
          <div className="mt-12">
            {rows.length > 0 ? (
              <Callout tone="amber" icon="alert">
                维护记录接口暂不可用，下方展示运行状态快照中的最近记录。
              </Callout>
            ) : null}
          </div>
        ) : null}

        <div className="mt-12">
          {degraded && rows.length === 0 ? (
            <ErrorState message={error ?? '维护记录加载失败'} onRetry={() => void refresh()} />
          ) : (
            <Table
              columns={columns}
              rows={rows}
              rowKey={(run) => run.id}
              loading={loading && !data && rows.length === 0}
              empty={
                <EmptyState
                  compact
                  icon="activity"
                  title="还没有维护记录"
                  description="执行一次演练后，这里会记录每次维护的类型、耗时与影响行数。"
                />
              }
            />
          )}
        </div>
      </div>
      <div className="card-foot tiny dim">
        维护任务由服务端定时调度，也可在此手动触发；所有执行都会写入审计日志并保留记录。
      </div>
    </Card>
  );
}
