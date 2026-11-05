import type { OpsStatus } from '@shared';
import { Badge, Card, Icon } from '@ui';
import { fmtBytes, fmtCompact, fmtFullDateTime, fmtInt, fmtMs, fmtPct } from '@lib/format.ts';
import { Metric, fmtUptime, maskDbPath } from './shared.tsx';

/** 「运行状态」卡片：进程环境、数据库与接口指标。 */
export function OpsStatusCard({ status }: { status: OpsStatus }) {
  const { database, metrics } = status;
  const errorRate = metrics.requestsTotal > 0 ? (metrics.errorsTotal / metrics.requestsTotal) * 100 : 0;
  const metricItems: { label: string; value: string; hint?: string }[] = [
    { label: '请求总量', value: fmtCompact(metrics.requestsTotal) },
    { label: '错误总数', value: fmtInt(metrics.errorsTotal), hint: `占 ${fmtPct(errorRate)}` },
    { label: 'P50 延迟', value: fmtMs(metrics.latencyP50Ms) },
    { label: 'P95 延迟', value: fmtMs(metrics.latencyP95Ms) },
    { label: 'SSE 连接', value: fmtInt(metrics.sseClients) },
    { label: '限流拦截', value: fmtInt(metrics.rateLimitedTotal) },
    { label: '认证失败', value: fmtInt(metrics.authFailuresTotal) },
  ];

  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="server" size={14} />
            运行状态
          </div>
          <div className="card-sub">服务进程、数据库与接口指标；指标自本次进程启动累计</div>
        </div>
        <Badge tone="green" size="sm" dot>
          {status.env || '运行中'}
        </Badge>
      </div>

      <div className="card-body">
        <div className="metric-grid">
          <Metric label="运行环境" value={status.env || '—'} />
          <Metric label="Node 版本" value={status.node || '—'} mono />
          <Metric
            label="数据库 schema"
            value={<Badge tone="violet" size="sm">schema-{database.schemaVersion}</Badge>}
          />
          <Metric label="日志模式" value={database.journalMode || '—'} mono />
          <Metric label="运行时长" value={fmtUptime(status.uptimeMs)} />
          <Metric label="启动时间" value={fmtFullDateTime(status.startedAt)} />
        </div>

        <div className="divider mt-16" />

        <div className="between wrap gap-8 mt-12">
          <span className="metric-label">接口指标</span>
          <span className="tiny dim">P95 反映真实调用延迟，错误率用于判断写入质量</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
            gap: '12px 16px',
            marginTop: 10,
          }}
        >
          {metricItems.map((item) => (
            <div className="metric" key={item.label}>
              <span className="metric-label">{item.label}</span>
              <span className="metric-value mono">{item.value}</span>
              {item.hint ? <span className="tiny dim">{item.hint}</span> : null}
            </div>
          ))}
        </div>

        <div className="divider mt-16" />

        <div className="between wrap gap-8 mt-12">
          <div className="vstack gap-2" style={{ minWidth: 0 }}>
            <span className="metric-label">数据库文件</span>
            <span className="mono small truncate" title="路径已脱敏，完整路径见服务端启动日志">
              {maskDbPath(database.path)}
            </span>
          </div>
          <div className="hstack gap-6 tiny dim nowrap">
            <span>数据 {fmtBytes(database.sizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span>WAL {fmtBytes(database.walSizeBytes)}</span>
          </div>
        </div>
        <div className="tiny dim mt-8">
          路径已脱敏显示；备份与恢复操作请以服务端 data 目录与启动日志为准。
        </div>
      </div>
    </Card>
  );
}
