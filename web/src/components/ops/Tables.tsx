import type { OpsStatus } from '@shared';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  Progress,
  Table,
  type Column,
} from '@ui';
import { fmtCompact, fmtInt, fmtPct } from '@lib/format.ts';
import { quotaLabel, quotaTone } from './shared.tsx';

type QuotaRow = OpsStatus['quotas'][number];
type RetentionRow = OpsStatus['retention'][number];

/** 「项目配额」卡片：按月 Token 配额展示用量与使用率。 */
export function QuotaCard({ quotas }: { quotas: QuotaRow[] }) {
  const nearLimit = quotas.filter((row) => row.usedPct > 90);
  const worst = nearLimit.reduce((max, row) => Math.max(max, row.usedPct), 0);

  const columns: Column<QuotaRow>[] = [
    {
      key: 'name',
      header: '项目',
      render: (row) => (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <span className="strong small truncate" title={row.name}>{row.name}</span>
          <span className="tiny dim mono truncate">{row.projectId}</span>
        </div>
      ),
    },
    {
      key: 'usedTokens',
      header: '已用 Token',
      align: 'right',
      mono: true,
      render: (row) => (
        <span title={`${fmtInt(row.usedTokens)} tokens`}>{fmtCompact(row.usedTokens)}</span>
      ),
    },
    {
      key: 'monthlyQuota',
      header: '月配额',
      align: 'right',
      mono: true,
      render: (row) =>
        row.monthlyQuota > 0 ? (
          <span title={`${fmtInt(row.monthlyQuota)} tokens`}>{fmtCompact(row.monthlyQuota)}</span>
        ) : (
          <span className="tiny dim">不限额</span>
        ),
    },
    {
      key: 'usedPct',
      header: '使用率',
      width: 210,
      render: (row) => (
        <div className="vstack gap-4" style={{ minWidth: 150 }}>
          <div className="between tiny dim">
            <span className="mono">{fmtPct(row.usedPct)}</span>
            <span style={{ color: `var(--${quotaTone(row.usedPct)})` }}>{quotaLabel(row.usedPct)}</span>
          </div>
          <Progress value={Math.min(100, row.usedPct)} thin tone={quotaTone(row.usedPct)} />
        </div>
      ),
    },
    {
      key: 'memories',
      header: '记忆数',
      align: 'right',
      mono: true,
      render: (row) => fmtCompact(row.memories),
    },
  ];

  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">项目配额</div>
          <div className="card-sub">按项目统计本月记忆注入 Token 用量；超限后写入会被限流</div>
        </div>
        <Badge tone={nearLimit.length > 0 ? 'amber' : 'slate'} size="sm">
          共 {fmtInt(quotas.length)} 个项目
        </Badge>
      </div>
      <div className="card-body">
        {nearLimit.length > 0 ? (
          <div className="mb-12">
            <Callout tone={worst > 100 ? 'red' : 'amber'} icon="gauge">
              有 {nearLimit.length} 个项目配额使用超过 90%
              {worst > 100 ? '，其中含已超额项目，写入将被直接限流' : ''}
              。请提升月配额或清理低价值记忆，避免影响线上召回。
            </Callout>
          </div>
        ) : null}

        <Table
          columns={columns}
          rows={quotas}
          rowKey={(row) => row.projectId}
          empty={
            <EmptyState
              compact
              icon="gauge"
              title="暂无项目配额数据"
              description="组织内还没有可统计的项目，创建项目并写入记忆后即可查看配额。"
            />
          }
        />
      </div>
    </Card>
  );
}

/** 「保留期」卡片：展示各项目保留天数与待归档记忆数。 */
export function RetentionCard({ retention }: { retention: RetentionRow[] }) {
  const pending = retention.filter((row) => row.expiredMemories > 0);
  const pendingCount = pending.reduce((sum, row) => sum + row.expiredMemories, 0);

  const columns: Column<RetentionRow>[] = [
    {
      key: 'name',
      header: '项目',
      render: (row) => <span className="small strong truncate" title={row.name}>{row.name}</span>,
    },
    {
      key: 'retentionDays',
      header: '保留天数',
      align: 'right',
      render: (row) => <span className="mono small">{fmtInt(row.retentionDays)} 天</span>,
    },
    {
      key: 'expiredMemories',
      header: '将过期记忆',
      align: 'right',
      render: (row) =>
        row.expiredMemories > 0 ? (
          <span className="mono small" style={{ color: 'var(--amber)' }}>
            {fmtInt(row.expiredMemories)}
          </span>
        ) : (
          <span className="tiny dim">0</span>
        ),
    },
  ];

  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">保留期</div>
          <div className="card-sub">维护任务按各项目 retentionDays 归档过期记忆</div>
        </div>
        <Badge tone={pendingCount > 0 ? 'amber' : 'green'} size="sm">
          {pendingCount > 0 ? `${fmtInt(pendingCount)} 条待归档` : '无待归档'}
        </Badge>
      </div>
      <div className="card-body">
        <Table
          columns={columns}
          rows={retention}
          rowKey={(row) => row.projectId}
          empty={
            <EmptyState
              compact
              icon="clock"
              title="暂无保留期配置"
              description="项目创建后默认继承组织的保留期策略，可在项目设置中覆写。"
            />
          }
        />
      </div>
      <div className="card-foot tiny dim">
        「将过期」统计已超过 retentionDays 但仍在生效的记忆；下个维护周期会将其归档为 archived，不会物理删除。
      </div>
    </Card>
  );
}
