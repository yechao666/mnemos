import { useMemo, useState, type ReactNode } from 'react';
import type { MemoryBrief } from '@lib/types.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { Button, Card, CopyButton, ErrorState, Icon, Skeleton } from '@ui';

/**
 * 人级 / 分区级记忆简报卡：按需读取、展开、复制、强制重新生成。
 * 简报可读接口返回缓存或确定性压缩结果，直接注入提示词即可。
 */
export function BriefCard({
  brief,
  loading,
  error,
  onRefresh,
  title = '记忆简报',
  desc = '最近的活跃记忆与洞见压缩成的可注入文本。',
  badge,
  canManage = true,
  emptyHint = '该范围还没有可纳入简报的记忆。',
}: {
  brief: MemoryBrief | null;
  loading: boolean;
  error: string | null;
  onRefresh: (force?: boolean) => void;
  title?: string;
  desc?: ReactNode;
  badge?: ReactNode;
  canManage?: boolean;
  emptyHint?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = brief?.text?.trim() ?? '';
  const isLong = useMemo(() => text.length > 260 || text.split('\n').length > 4, [text]);

  return (
    <Card pad className="memory-brief-card">
      <div className="memory-brief-head">
        <div className="memory-brief-title">
          <span className="memory-brief-icon" aria-hidden="true">
            <Icon name="sparkles" size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="hstack gap-8 wrap">
              <span className="strong">{title}</span>
              {badge}
              {brief?.cached ? (
                <span className="tiny dim" title="命中缓存">缓存</span>
              ) : null}
            </div>
            <div className="tiny dim mt-4">{desc}</div>
          </div>
        </div>
        <div className="hstack gap-6 wrap">
          {text ? <CopyButton value={text} label="复制简报" /> : null}
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            loading={loading}
            onClick={() => onRefresh(true)}
          >
            重新生成
          </Button>
        </div>
      </div>

      {loading && !brief ? (
        <div className="vstack gap-8 mt-12">
          <Skeleton h={12} />
          <Skeleton h={12} w="86%" />
          <Skeleton h={12} w="64%" />
        </div>
      ) : error && !brief ? (
        <div className="mt-12">
          <ErrorState message={error} onRetry={() => onRefresh(false)} />
        </div>
      ) : brief ? (
        <>
          <div className={`memory-brief-body ${expanded ? 'is-expanded' : ''} ${text ? '' : 'is-plain'}`}>
            {text ? (
              <div className="memory-brief-text">{text}</div>
            ) : (
              <div className="tiny dim">{emptyHint}</div>
            )}
          </div>
          <div className="memory-brief-foot">
            <div className="hstack gap-8 wrap tiny dim">
              <span>纳入 {fmtInt(brief.count)} 条记忆</span>
              <span>上限 {fmtInt(brief.maxChars)} 字</span>
              <span className="mono">{brief.model}</span>
              {brief.generatedAt ? (
                <span title={brief.generatedAt}>生成于 {fmtRelative(brief.generatedAt)}</span>
              ) : null}
              {brief.recent.length ? (
                <span className="chip">{fmtInt(brief.recent.length)} 条近期条目</span>
              ) : null}
            </div>
            <div className="hstack gap-6">
              {isLong ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={expanded ? 'chevronUp' : 'chevronDown'}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? '收起' : '展开全文'}
                </Button>
              ) : null}
              {canManage ? (
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => onRefresh(false)}>
                  读取缓存
                </Button>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <div className="vstack gap-10 mt-12">
          <div className="tiny dim">尚未读取简报。</div>
          <div>
            <Button size="sm" variant="primary" icon="sparkles" onClick={() => onRefresh(false)}>
              生成简报
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
