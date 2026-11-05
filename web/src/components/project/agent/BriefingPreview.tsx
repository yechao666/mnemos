import { useMemo } from 'react';
import type { BriefingSection, SearchHit } from '@shared';
import { CATEGORY_LABEL } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  Icon,
  LoadingBlock,
  Modal,
  SectionHead,
  Skeleton,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync, useCopy } from '@lib/hooks.ts';
import { fmtFullDateTime, fmtInt, fmtMs, fmtRelative, truncateMiddle } from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { clickableRowStyle, ScoreMeter } from '../shared.tsx';
import {
  BRIEFING_SECTION_FALLBACK,
  BRIEFING_SECTION_ICONS,
  isNotFoundError,
} from './shared.tsx';

export interface BriefingPreviewProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  agentId?: string;
  taskId?: string;
  query?: string;
}

/** 上下文简报：按作用分层展示可直接注入 Agent 的系统提示词与记忆来源。 */
export function BriefingPreview({ open, onClose, projectId, agentId, taskId, query }: BriefingPreviewProps) {
  const { data, loading, error, refresh } = useAsync(
    () => api.briefing(projectId, { agentId, taskId, query }),
    [projectId, agentId, taskId, query, open],
    open && Boolean(projectId),
  );

  const totalHits = useMemo(
    () => (data?.sections ?? []).reduce((sum, section) => sum + section.hits.length, 0),
    [data],
  );
  const nonEmptySections = useMemo(
    () => (data?.sections ?? []).filter((section) => section.hits.length > 0),
    [data],
  );
  const citationCount = data?.citations?.length ?? 0;

  const targetAgent = data?.agent?.name ?? (agentId ? `Agent ${truncateMiddle(agentId, 10, 4)}` : '');
  const targetTask = data?.task?.title ?? (taskId ? `任务 ${truncateMiddle(taskId, 8, 4)}` : '');
  const target = [targetAgent, targetTask].filter(Boolean).join(' · ');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上下文简报"
      description={target ? `面向 ${target} 的注入预览` : '汇总项目内可直接注入 Agent 的系统提示词与来源'}
      size="lg"
      footer={
        <>
          <Button icon="refresh" loading={loading} disabled={!projectId} onClick={() => void refresh()}>
            重新生成
          </Button>
          <span className="ml-auto" />
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="vstack gap-12">
          <Skeleton h={54} />
          <Skeleton h={150} />
          <Skeleton h={110} />
          <Skeleton h={110} />
        </div>
      ) : null}

      {!loading && error && !data ? (
        <div className="vstack gap-10">
          <ErrorState message={error} onRetry={() => void refresh()} />
          {isNotFoundError(error) ? (
            <Callout tone="amber" icon="info">
              后端简报接口尚未就绪时会返回 404；接口上线后点击「重新生成」即可恢复，无需刷新页面。
            </Callout>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && !data ? <LoadingBlock label="正在生成简报…" /> : null}

      {data ? (
        <div className="vstack gap-16">
          {error ? (
            <Callout tone="amber" icon="alert">
              刷新简报失败，当前展示上一次成功生成的内容：{error}
            </Callout>
          ) : null}

          {totalHits === 0 ? (
            <EmptyState
              icon="brain"
              title="暂无可纳入简报的记忆"
              description="先写入项目规范、架构决策或事故复盘；结束任务时提交的 decisions / lessons 也会自动成为项目共享记忆，下次生成简报即可汇总。"
            />
          ) : (
            <>
              <div className="vstack gap-10">
                <Callout tone="violet" icon="sparkles">
                  这段文本可直接作为 Agent 的 system prompt 前缀。与任务说明一起注入，可减少重复解释，并让 Agent 看到前一位同事的结论与踩坑记录。
                </Callout>
                <div style={{ maxHeight: 300, overflowY: 'auto', borderRadius: 'var(--radius-md)' }}>
                  <CodeBlock
                    title="system-prompt-prefix.md"
                    language="markdown"
                    code={data.prompt || '（本次简报未生成可注入文本）'}
                  />
                </div>
              </div>

              <div className="grid grid-4">
                <div className="metric">
                  <span className="metric-label">Token 估算</span>
                  <span className="metric-value">{fmtInt(data.tokenEstimate)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">生成耗时</span>
                  <span className="metric-value">{fmtMs(data.tookMs)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">命中记忆</span>
                  <span className="metric-value">
                    {fmtInt(totalHits)} 条 · {fmtInt(citationCount)} 处引用
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">生成时间</span>
                  <span className="metric-value" title={fmtFullDateTime(data.builtAt)}>
                    {fmtRelative(data.builtAt)}
                  </span>
                </div>
              </div>

              <div className="vstack gap-12">
                {nonEmptySections.map((section) => (
                  <BriefingSectionCard
                    key={section.key}
                    section={section}
                    briefingAgentId={data.agent?.id}
                    briefingAgentName={data.agent?.name}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function BriefingSectionCard({
  section,
  briefingAgentId,
  briefingAgentName,
}: {
  section: BriefingSection;
  briefingAgentId?: string;
  briefingAgentName?: string;
}) {
  return (
    <Card pad>
      <SectionHead
        title={
          <span className="hstack gap-8">
            <Icon name={BRIEFING_SECTION_ICONS[section.key] ?? 'layers'} size={13} />
            {section.title || BRIEFING_SECTION_FALLBACK[section.key] || section.key}
          </span>
        }
        desc={section.description}
        actions={
          <Badge tone="slate" size="sm">
            {section.hits.length} 条
          </Badge>
        }
      />
      <div className="vstack gap-8 mt-12">
        {section.hits.map((hit) => (
          <BriefingHit
            key={hit.id}
            hit={hit}
            agentName={hit.agentId && hit.agentId === briefingAgentId ? briefingAgentName : undefined}
          />
        ))}
      </div>
    </Card>
  );
}

function BriefingHit({ hit, agentName }: { hit: SearchHit; agentName?: string }) {
  const toast = useToast();
  const [, copy] = useCopy();

  return (
    <button
      type="button"
      style={clickableRowStyle}
      title={`点击复制记忆 ID：${hit.id}`}
      onClick={() => {
        copy(hit.id);
        toast.info(`已复制记忆 ID：${truncateMiddle(hit.id, 10, 6)}`);
      }}
    >
      <div className="mem-content clamp-2">{hit.content}</div>
      <div className="chip-row mt-6">
        <Badge tone={toneForCategory(hit.category)} size="sm">
          {CATEGORY_LABEL[hit.category]}
        </Badge>
        {hit.agentId ? (
          <span className="chip" title={`写入 Agent：${hit.agentId}`}>
            <Icon name="bot" size={11} />
            <span className="truncate" style={{ maxWidth: 150 }}>
              {agentName ?? truncateMiddle(hit.agentId, 12, 4)}
            </span>
          </span>
        ) : null}
        {hit.taskId ? (
          <span className="chip" title={`任务：${hit.taskId}`}>
            <Icon name="branch" size={11} />
            <span className="truncate" style={{ maxWidth: 120 }}>
              {truncateMiddle(hit.taskId, 8, 4)}
            </span>
          </span>
        ) : null}
        <span className="tiny dim" title={fmtFullDateTime(hit.createdAt)}>
          {fmtRelative(hit.createdAt)}
        </span>
        <span className="hstack gap-6 ml-auto">
          <ScoreMeter score={hit.score} />
          <span className="tiny dim hstack gap-4">
            <Icon name="copy" size={10} />
            复制 ID
          </span>
        </span>
      </div>
    </button>
  );
}
