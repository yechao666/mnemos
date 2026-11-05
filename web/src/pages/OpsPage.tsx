import { useEffect, useState } from 'react';
import { api, ApiError } from '@lib/api.ts';
import { useAsync, useInterval } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { ROLE_LABEL } from '@lib/tone.ts';
import { fmtBytes, fmtCompact, fmtInt, fmtMs } from '@lib/format.ts';
import {
  Button,
  Callout,
  Card,
  ErrorState,
  Icon,
  PageHead,
  Segmented,
  Skeleton,
  Stat,
  type IconName,
  type Tone,
} from '@ui';
import { OpsStatusCard } from '../components/ops/StatusCard.tsx';
import { QuotaCard, RetentionCard } from '../components/ops/Tables.tsx';
import { BackupsCard } from '../components/ops/BackupsCard.tsx';
import { MaintenanceCard } from '../components/ops/MaintenanceCard.tsx';
import { fmtUptime } from '../components/ops/shared.tsx';

type RefreshInterval = 0 | 10_000 | 30_000;

const REFRESH_OPTIONS: { value: RefreshInterval; label: string }[] = [
  { value: 0, label: '关闭' },
  { value: 10_000, label: '10s' },
  { value: 30_000, label: '30s' },
];

const CAPABILITIES: { icon: IconName; title: string; desc: string; tone: Tone }[] = [
  { icon: 'activity', title: '运行状态与接口指标', desc: '进程版本、数据库 schema、P50 / P95 延迟与错误率', tone: 'violet' },
  { icon: 'gauge', title: '项目配额与保留期', desc: '按项目查看 Token 用量、配额水位与待归档记忆', tone: 'cyan' },
  { icon: 'package', title: '备份创建与下载', desc: '在线备份 SQLite 数据库，下载归档到本地或对象存储', tone: 'amber' },
  { icon: 'play', title: '维护演练与执行', desc: '按保留期归档、清理软删除记录，可选 VACUUM', tone: 'green' },
];

export function OpsPage() {
  const { user } = useAuth();
  const isAdminRole = user?.role === 'admin' || user?.role === 'owner';
  const [forbidden, setForbidden] = useState(false);
  const [refreshMs, setRefreshMs] = useState<RefreshInterval>(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const { data, loading, error, refresh } = useAsync(
    async () => {
      try {
        const status = await api.ops.status();
        setForbidden(false);
        return status;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
        throw cause;
      }
    },
    [],
    isAdminRole,
  );

  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);

  // 自动刷新只更新运行指标，不重置筛选或弹窗状态。
  useInterval(
    () => {
      void refresh();
    },
    refreshMs > 0 && isAdminRole ? refreshMs : null,
  );

  const refreshAll = () => {
    setReloadKey((value) => value + 1);
    void refresh();
  };

  const denied = forbidden || !isAdminRole;
  const updatedLabel = updatedAt ? updatedAt.toLocaleTimeString('zh-CN', { hour12: false }) : null;
  const desc = `生产运行状态、配额、保留期、备份与维护${updatedLabel ? ` · 更新于 ${updatedLabel}` : ''}`;

  return (
    <div className="page">
      <PageHead
        eyebrow="组织 · 运维"
        title="系统运维"
        desc={desc}
        actions={
          denied ? undefined : (
            <>
              <span
                className="tiny dim nowrap"
                title="自动刷新只更新运行状态与统计，不重新加载备份与维护记录"
              >
                自动刷新
              </span>
              <Segmented options={REFRESH_OPTIONS} value={refreshMs} onChange={setRefreshMs} />
              <Button icon="refresh" loading={loading} onClick={refreshAll}>
                刷新
              </Button>
            </>
          )
        }
      />

      {denied ? (
        <>
          <Callout tone="amber" icon="lock">
            <strong>需要管理员权限。</strong>
            运维视图（运行状态、备份、维护与项目配额）仅对组织管理员与所有者开放。
            {user ? `当前账号角色为「${ROLE_LABEL[user.role]}」。` : ''}
            如需查看或执行维护，请联系组织管理员。
          </Callout>

          <Card pad>
            <div className="hstack gap-8 mb-12">
              <span style={{ color: 'var(--violet)' }}>
                <Icon name="shield" size={15} />
              </span>
              <span className="section-title">管理员可用的运维能力</span>
            </div>
            <div className="vstack gap-10">
              {CAPABILITIES.map((item) => (
                <div className="hstack gap-10" key={item.title}>
                  <span className={`kpi-icon tone-${item.tone}`} style={{ width: 24, height: 24, borderRadius: 7 }}>
                    <Icon name={item.icon} size={13} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="small strong">{item.title}</div>
                    <div className="tiny dim">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="divider mt-16" />
            <div className="between wrap gap-8 mt-12">
              <span className="tiny dim">
                权限由组织级角色决定；项目内的成员角色不影响本页访问，请联系管理员调整组织角色。
              </span>
              {forbidden && isAdminRole ? (
                <Button size="sm" icon="refresh" loading={loading} onClick={() => void refresh()}>
                  重新检测权限
                </Button>
              ) : null}
            </div>
          </Card>
        </>
      ) : null}

      {!denied && loading && !data ? (
        <>
          <div className="kpi-grid">
            {[0, 1, 2, 3].map((index) => (
              <div className="kpi" key={index}>
                <Skeleton w="42%" h={11} />
                <div style={{ height: 12 }} />
                <Skeleton w="64%" h={26} />
                <div style={{ height: 10 }} />
                <Skeleton w="80%" h={10} />
              </div>
            ))}
          </div>
          <Card pad>
            <Skeleton h={180} />
          </Card>
          <Card pad>
            <Skeleton h={140} />
          </Card>
        </>
      ) : null}

      {!denied && !loading && error && !data ? (
        <>
          <Card pad>
            <ErrorState message={error} onRetry={() => void refresh()} />
          </Card>
          <Callout tone="slate" icon="info">
            运维接口由服务端平台层提供。若后端尚未部署对应路由，本页会在接口就绪后自动恢复，可稍后点击重试。
          </Callout>
        </>
      ) : null}

      {!denied && data ? (
        <>
          {error ? (
            <Callout tone="amber" icon="alert">
              刷新失败，当前展示上次成功获取的数据{updatedLabel ? `（${updatedLabel}）` : ''}：{error}
            </Callout>
          ) : null}

          <div className="kpi-grid">
            <Stat
              label="服务版本"
              value={`v${data.version}`}
              icon="server"
              tone="violet"
              hint={`已运行 ${fmtUptime(data.uptimeMs)} · ${data.env || '未知环境'}`}
            />
            <Stat
              label="数据库大小"
              value={fmtBytes(data.database.sizeBytes)}
              icon="database"
              tone="cyan"
              hint={`WAL ${fmtBytes(data.database.walSizeBytes)} · ${data.database.journalMode}`}
            />
            <Stat
              label="记忆总量"
              value={fmtInt(data.counts.memories)}
              unit="条"
              icon="brain"
              tone="pink"
              hint={`用户 ${fmtInt(data.counts.users)} · 项目 ${fmtInt(data.counts.projects)} · Agent ${fmtInt(data.counts.agents)}`}
            />
            <Stat
              label="请求 P95"
              value={fmtMs(data.metrics.latencyP95Ms)}
              icon="gauge"
              tone="amber"
              hint={`P50 ${fmtMs(data.metrics.latencyP50Ms)} · 请求 ${fmtCompact(data.metrics.requestsTotal)}`}
            />
          </div>

          <OpsStatusCard status={data} />

          <QuotaCard quotas={data.quotas} />

          <div className="grid grid-2">
            <RetentionCard retention={data.retention} />
            <BackupsCard
              fallback={data.backups}
              reloadKey={reloadKey}
              enabled={!denied}
              onChanged={() => void refresh()}
            />
          </div>

          <MaintenanceCard
            fallback={data.maintenance}
            reloadKey={reloadKey}
            enabled={!denied}
            onRan={() => void refresh()}
          />
        </>
      ) : null}
    </div>
  );
}
