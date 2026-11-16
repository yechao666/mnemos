import { useState } from 'react';
import type { MemoryBrief } from '@shared';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Skeleton,
} from '@ui';
import { fmtRelative } from '@lib/format.ts';
import { briefModelMeta } from './shared.tsx';

export interface MemoryBriefCardProps {
  brief: MemoryBrief | null;
  loading: boolean;
  error: string | null;
  /** 是否显示「设置」入口（写接口需 admin，只读角色隐藏） */
  canManage: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

/**
 * 记忆简报置顶卡：展示 Agent 可直接注入的最近记忆摘要，支持展开、复制与刷新。
 * 数据由页面通过 useAsync 传入，组件本身无请求与全局状态。
 */
export function MemoryBriefCard({
  brief,
  loading,
  error,
  canManage,
  onRefresh,
  onOpenSettings,
}: MemoryBriefCardProps) {
  const [expanded, setExpanded] = useState(false);
  const model = briefModelMeta(brief);
  const text = brief?.text?.trim() ?? '';
  const initialLoading = loading && !brief;

  return (
    <Card pad className="memory-brief-card">
      <div className="memory-brief-head">
        <div className="memory-brief-title">
          <span className="memory-brief-icon">
            <Icon name="sparkles" size={16} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="hstack gap-6 wrap">
              <strong>记忆简报</strong>
              <Badge size="sm" tone="violet" dot>
                最近记忆
              </Badge>
              <Badge size="sm" tone={model.tone}>
                {model.label}
              </Badge>
              {brief?.cached ? (
                <Badge size="sm" tone="green">
                  缓存
                </Badge>
              ) : null}
            </div>
            <div className="tiny dim mt-4">
              只取最近活跃记忆与洞见，Agent 接入时可直接注入。
            </div>
          </div>
        </div>
        {canManage ? (
          <Button size="sm" variant="ghost" icon="settings" onClick={onOpenSettings}>
            设置
          </Button>
        ) : null}
      </div>

      {initialLoading ? (
        <div className="memory-brief-body is-plain">
          <div className="vstack gap-8">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} w={index === 2 ? '62%' : '100%'} h={11} />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="memory-brief-body is-plain">
          <ErrorState message={error} onRetry={onRefresh} />
        </div>
      ) : text ? (
        <div className={`memory-brief-body${expanded ? ' is-expanded' : ''}`}>
          <div className="memory-brief-text">{text}</div>
        </div>
      ) : (
        <div className="memory-brief-body is-plain">
          <EmptyState
            compact
            icon="brain"
            title="当前还没有可用的活跃记忆"
            description="写入记忆后，这里会展示可直接注入提示词的最近记忆摘要。"
          />
        </div>
      )}

      <div className="memory-brief-foot">
        <span className="tiny dim">
          {initialLoading
            ? '正在生成记忆简报…'
            : `${brief?.count ?? 0} 条最近记忆 · 上限 ${brief?.maxChars ?? '—'} 字${
                brief?.generatedAt ? ` · 生成于 ${fmtRelative(brief.generatedAt)}` : ''
              }`}
        </span>
        <div className="hstack gap-4 wrap">
          {text ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开全文'}
            </Button>
          ) : null}
          {text ? <CopyButton value={brief?.text ?? ''} label="复制简报" /> : null}
          <IconButton
            icon="refresh"
            label="刷新记忆简报"
            size="sm"
            disabled={loading}
            onClick={onRefresh}
          />
        </div>
      </div>
    </Card>
  );
}
