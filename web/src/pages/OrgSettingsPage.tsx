import type { ReactNode } from 'react';
import { APP_VERSION, DEFAULT_PROJECT_SETTINGS } from '@shared';
import { Badge, Button, Callout, Card, EmptyState, PageHead, Skeleton, type Tone } from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtDate } from '@lib/format.ts';
import { ROLE_LABEL } from '@lib/tone.ts';

function fmtUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function Metric({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

export function OrgSettingsPage() {
  const { org, user } = useAuth();
  const health = useAsync(() => api.health(), []);

  const healthTone: Tone = health.error ? 'red' : health.data ? (health.data.ok ? 'green' : 'amber') : 'slate';
  const healthLabel = health.loading
    ? '检测中'
    : health.error
      ? '不可用'
      : health.data
        ? health.data.ok
          ? '运行正常'
          : '状态异常'
        : '未知';

  return (
    <div className="page">
      <PageHead
        eyebrow="组织"
        title="组织设置"
        desc={org ? `${org.name} 的基础资料、平台诊断与安全策略（当前为只读视图）` : '组织资料、平台诊断与安全策略'}
        actions={
          <Button icon="refresh" loading={health.loading} onClick={() => void health.refresh()}>
            刷新诊断
          </Button>
        }
      />

      {!org ? (
        <Card pad>
          <EmptyState
            icon="settings"
            title="组织资料不可用"
            description="未能读取到当前组织档案，请刷新会话或稍后重试。"
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-2">
            <Card>
              <div className="card-head">
                <div>
                  <div className="card-title">组织资料</div>
                  <div className="card-sub">由服务端组织档案同步，当前为只读</div>
                </div>
                <Badge tone="violet" size="sm">{org.plan}</Badge>
              </div>
              <div className="card-body">
                <div className="metric-grid">
                  <Metric label="组织名称" value={org.name} />
                  <Metric label="组织 slug" value={org.slug} mono />
                  <Metric label="计划" value={org.plan} />
                  <Metric label="创建时间" value={fmtDate(org.createdAt)} />
                  <Metric label="组织 ID" value={org.id} mono />
                  <Metric
                    label="当前账号"
                    value={user ? `${user.name} · ${ROLE_LABEL[user.role]}` : '—'}
                  />
                </div>
              </div>
            </Card>

            <Card>
              <div className="card-head">
                <div>
                  <div className="card-title">平台诊断</div>
                  <div className="card-sub">实时读取 /api/health</div>
                </div>
                <Badge tone={healthTone} size="sm" dot>{healthLabel}</Badge>
              </div>
              <div className="card-body">
                {health.loading && !health.data ? (
                  <div className="vstack gap-10">
                    <Skeleton w="55%" h={12} />
                    <Skeleton w="42%" h={12} />
                    <Skeleton w="66%" h={12} />
                  </div>
                ) : health.error ? (
                  <Callout tone="red" icon="alert">{health.error}</Callout>
                ) : (
                  <div className="metric-grid">
                    <Metric label="服务版本" value={health.data?.version ?? '—'} mono />
                    <Metric label="运行时长" value={fmtUptime(health.data?.uptimeMs)} />
                    <Metric label="健康检查" value={health.data?.ok ? '通过' : '异常'} />
                    <Metric label="接口地址" value="/api/health" mono />
                  </div>
                )}
                <div className="divider mt-16" />
                <div className="tiny dim mt-12">
                  诊断结果用于排查控制台与记忆引擎的连通性；不可用时页面其余数据仍可只读浏览。
                </div>
              </div>
            </Card>
          </div>

          <div className="grid grid-2">
            <Card>
              <div className="card-head">
                <div>
                  <div className="card-title">安全与合规</div>
                  <div className="card-sub">平台内置策略，随项目设置生效</div>
                </div>
                <Badge tone="green" size="sm" dot>已启用</Badge>
              </div>
              <div className="card-body">
                <div className="metric-grid">
                  <Metric label="多项目隔离" value="记忆、密钥与用量按项目强制隔离" />
                  <Metric label="审计日志" value="写操作全量留痕，可按项目检索与回放" />
                  <Metric label="密钥作用域" value="读 / 写 / 图谱 / 管理四级作用域" />
                  <Metric
                    label="数据保留策略"
                    value={`默认 ${DEFAULT_PROJECT_SETTINGS.retentionDays} 天，可按项目覆写`}
                  />
                </div>
                <div className="mt-16">
                  <Callout tone="slate" icon="lock">
                    组织级设置当前只读；进入具体项目的「设置」可调整抽取模式、检索权重、保留天数与配额。
                  </Callout>
                </div>
              </div>
            </Card>

            <Card>
              <div className="card-head">
                <div>
                  <div className="card-title">环境</div>
                  <div className="card-sub">当前控制台的运行环境信息</div>
                </div>
                <Badge tone="cyan" size="sm">同源部署</Badge>
              </div>
              <div className="card-body">
                <div className="metric-grid">
                  <Metric label="API 地址" value={window.location.origin} mono />
                  <Metric label="控制台版本" value={APP_VERSION} mono />
                  <Metric
                    label="默认嵌入模型"
                    value={DEFAULT_PROJECT_SETTINGS.embeddingModel}
                    mono
                  />
                  <Metric
                    label="检索默认值"
                    value={`TopK ${DEFAULT_PROJECT_SETTINGS.topK} · 阈值 ${DEFAULT_PROJECT_SETTINGS.threshold}`}
                  />
                </div>
                <div className="divider mt-16" />
                <div className="tiny dim mt-12">
                  嵌入模型可在项目级覆盖；不同区域的记忆不共享索引，跨项目检索需显式授权。
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
