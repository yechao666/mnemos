import { useState } from 'react';
import type { BackupInfo } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtBytes, fmtDateTime, fmtFullDateTime, fmtRelative } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Table,
  useToast,
  type Column,
} from '@ui';

const BACKUP_KIND: Record<BackupInfo['kind'], { label: string; tone: 'violet' | 'cyan' | 'amber' }> = {
  manual: { label: '手动', tone: 'violet' },
  scheduled: { label: '定时', tone: 'cyan' },
  preflight: { label: '备份前', tone: 'amber' },
};

/**
 * 「备份」卡片：创建与下载 SQLite 备份。
 * 备份列表优先读 /api/ops/backups；接口不可用时回退到运行状态快照中的最近备份。
 */
export function BackupsCard({
  fallback,
  reloadKey,
  enabled,
  onChanged,
}: {
  fallback: BackupInfo[];
  reloadKey: number;
  enabled: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const { data, loading, error, refresh } = useAsync(
    () => api.ops.backups.list(),
    [reloadKey],
    enabled,
  );

  const rows = data ?? fallback;
  const degraded = Boolean(error) && !data;

  const createBackup = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await api.ops.backups.create();
      toast.success(`备份已创建：${created.file}`, '备份完成');
      await refresh();
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '创建备份失败，请稍后重试。');
    } finally {
      setCreating(false);
    }
  };

  const downloadBackup = async (file: string) => {
    if (downloading) return;
    setDownloading(file);
    try {
      const blob = await api.ops.backups.download(file);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('备份下载已开始');
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '备份下载失败，请稍后重试。');
    } finally {
      setDownloading(null);
    }
  };

  const columns: Column<BackupInfo>[] = [
    {
      key: 'file',
      header: '文件',
      render: (backup) => (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <span className="mono small truncate" title={backup.file} style={{ display: 'block', maxWidth: 240 }}>
            {backup.file}
          </span>
          <Badge tone={BACKUP_KIND[backup.kind]?.tone ?? 'slate'} size="sm">
            {BACKUP_KIND[backup.kind]?.label ?? backup.kind}
          </Badge>
        </div>
      ),
    },
    {
      key: 'sizeBytes',
      header: '大小',
      align: 'right',
      mono: true,
      render: (backup) => fmtBytes(backup.sizeBytes),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (backup) => (
        <span className="tiny muted nowrap" title={fmtFullDateTime(backup.createdAt)}>
          {fmtDateTime(backup.createdAt)} · {fmtRelative(backup.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 92,
      align: 'right',
      render: (backup) => (
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          loading={downloading === backup.file}
          onClick={() => void downloadBackup(backup.file)}
        >
          下载
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">备份</div>
          <div className="card-sub">SQLite 在线备份，可下载归档到本地或对象存储</div>
        </div>
        <Button
          size="sm"
          variant="primary"
          icon="package"
          loading={creating}
          disabled={!enabled}
          onClick={() => void createBackup()}
        >
          创建备份
        </Button>
      </div>
      <div className="card-body">
        {degraded ? (
          <div className="mb-12">
            {rows.length > 0 ? (
              <Callout tone="amber" icon="alert">
                备份列表接口暂不可用，下方展示运行状态快照中的最近备份；创建与下载可能同样失败。
              </Callout>
            ) : null}
          </div>
        ) : null}

        {degraded && rows.length === 0 ? (
          <ErrorState message={error ?? '备份列表加载失败'} onRetry={() => void refresh()} />
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(backup) => backup.id || backup.file}
            loading={loading && !data && rows.length === 0}
            empty={
              <EmptyState
                compact
                icon="package"
                title="还没有备份"
                description="创建备份后会在此列出归档文件，可随时下载保存。"
                action={
                  <Button size="sm" variant="primary" icon="package" loading={creating} onClick={() => void createBackup()}>
                    创建第一份备份
                  </Button>
                }
              />
            }
          />
        )}
      </div>
      <div className="card-foot tiny dim">
        备份文件保存在服务器 data/backups 目录；下载通过鉴权请求完成，不会公开暴露文件路径。
      </div>
    </Card>
  );
}
